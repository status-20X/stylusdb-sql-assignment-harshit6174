const { parseSelectQuery } = require('./queryParser.js');
const { readCSV, readCSVForHLL, writeCSV } = require('./csvStorage.js');
const hll = require('hll');


function performInnerJoin(data, joinData, joinCondition, fields, table) {
    return data.flatMap(mainRow => {
        return joinData
            .filter(joinRow => {
                const mainValue = mainRow[joinCondition.left.split('.')[1]];
                const joinValue = joinRow[joinCondition.right.split('.')[1]];
                return mainValue === joinValue;
            })
            .map(joinRow => {
                return fields.reduce((acc, field) => {
                    const [tableName, fieldName] = field.split('.');
                    acc[field] = tableName === table ? mainRow[fieldName] : joinRow[fieldName];
                    return acc;
                }, {});
            });
    });
}

function performLeftJoin(data, joinData, joinCondition, fields, table) {
    return data.flatMap(mainRow => {
        const matchingJoinRows = joinData.filter(joinRow => {
            const mainValue = getValueFromRow(mainRow, joinCondition.left);
            const joinValue = getValueFromRow(joinRow, joinCondition.right);
            return mainValue === joinValue;
        });

        if (matchingJoinRows.length === 0) {
            return [createResultRow(mainRow, null, fields, table, true)];
        }

        return matchingJoinRows.map(joinRow => createResultRow(mainRow, joinRow, fields, table, true));
    });
}

function getValueFromRow(row, compoundFieldName) {
    const [tableName, fieldName] = compoundFieldName.split('.');
    return row[`${tableName}.${fieldName}`] || row[fieldName];
}

function performRightJoin(data, joinData, joinCondition, fields, table) {
    
    const mainTableRowStructure = data.length > 0 ? Object.keys(data[0]).reduce((acc, key) => {
        acc[key] = null; 
        return acc;
    }, {}) : {};

    return joinData.map(joinRow => {
        const mainRowMatch = data.find(mainRow => {
            const mainValue = getValueFromRow(mainRow, joinCondition.left);
            const joinValue = getValueFromRow(joinRow, joinCondition.right);
            return mainValue === joinValue;
        });

        
        const mainRowToUse = mainRowMatch || mainTableRowStructure;

        
        return createResultRow(mainRowToUse, joinRow, fields, table, true);
    });
}

function createResultRow(mainRow, joinRow, fields, table, includeAllMainFields) {
    const resultRow = {};

    if (includeAllMainFields) {
        
        Object.keys(mainRow || {}).forEach(key => {
            const prefixedKey = `${table}.${key}`;
            resultRow[prefixedKey] = mainRow ? mainRow[key] : null;
        });
    }

    
    fields.forEach(field => {
        const [tableName, fieldName] = field.includes('.') ? field.split('.') : [table, field];
        resultRow[field] = tableName === table && mainRow ? mainRow[fieldName] : joinRow ? joinRow[fieldName] : null;
    });

    return resultRow;
}

function evaluateCondition(row, clause) {
    let { field, operator, value } = clause;

    // Check if the field exists in the row
    if (row[field] === undefined) {
        throw new Error(`Invalid field: ${field}`);
    }

    // Parse row value and condition value based on their actual types
    const rowValue = parseValue(row[field]);
    let conditionValue = parseValue(value);

    if (operator === 'LIKE') {
        
        const regexPattern = '^' + value.replace(/%/g, '.*').replace(/_/g, '.') + '$';
        const regex = new RegExp(regexPattern, 'i'); 
        return regex.test(row[field]);
    }

    switch (operator) {
        case '=': return rowValue === conditionValue;
        case '!=': return rowValue !== conditionValue;
        case '>': return rowValue > conditionValue;
        case '<': return rowValue < conditionValue;
        case '>=': return rowValue >= conditionValue;
        case '<=': return rowValue <= conditionValue;
        default: throw new Error(`Unsupported operator: ${operator}`);
    }
}

// Helper function to parse value based on its apparent type
function parseValue(value) {

    
    if (value === null || value === undefined) {
        return value;
    }

    
    if (typeof value === 'string' && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
        value = value.substring(1, value.length - 1);
    }

    // Check if value is a number
    if (!isNaN(value) && value.trim() !== '') {
        return Number(value);
    }
    
    return value;
}

function applyGroupBy(data, groupByFields, aggregateFunctions) {
    const groupResults = {};

    data.forEach(row => {
        
        const groupKey = groupByFields.map(field => row[field]).join('-');

        
        if (!groupResults[groupKey]) {
            groupResults[groupKey] = { count: 0, sums: {}, mins: {}, maxes: {} };
            groupByFields.forEach(field => groupResults[groupKey][field] = row[field]);
        }

        
        groupResults[groupKey].count += 1;
        aggregateFunctions.forEach(func => {
            const match = /(\w+)\((\w+)\)/.exec(func);
            if (match) {
                const [, aggFunc, aggField] = match;
                const value = parseFloat(row[aggField]);

                switch (aggFunc.toUpperCase()) {
                    case 'SUM':
                        groupResults[groupKey].sums[aggField] = (groupResults[groupKey].sums[aggField] || 0) + value;
                        break;
                    case 'MIN':
                        groupResults[groupKey].mins[aggField] = Math.min(groupResults[groupKey].mins[aggField] || value, value);
                        break;
                    case 'MAX':
                        groupResults[groupKey].maxes[aggField] = Math.max(groupResults[groupKey].maxes[aggField] || value, value);
                        break;
                    
                }
            }
        });
    });

    
    return Object.values(groupResults).map(group => {
        
        const finalGroup = {};
        groupByFields.forEach(field => finalGroup[field] = group[field]);
        aggregateFunctions.forEach(func => {
            const match = /(\w+)\((\*|\w+)\)/.exec(func);
            if (match) {
                const [, aggFunc, aggField] = match;
                switch (aggFunc.toUpperCase()) {
                    case 'SUM':
                        finalGroup[func] = group.sums[aggField];
                        break;
                    case 'MIN':
                        finalGroup[func] = group.mins[aggField];
                        break;
                    case 'MAX':
                        finalGroup[func] = group.maxes[aggField];
                        break;
                    case 'COUNT':
                        finalGroup[func] = group.count;
                        break;
                    
                }
            }
        });

        return finalGroup;
    });
}

async function executeSELECTQuery(query) {
    try {
        const { fields, table, whereClauses, joinType, joinTable, joinCondition, groupByFields, hasAggregateWithoutGroupBy, isApproximateCount, orderByFields, limit, isDistinct, distinctFields, isCountDistinct } = parseSelectQuery(query);


        if (isApproximateCount && fields.length === 1 && fields[0] === 'COUNT(*)' && whereClauses.length === 0) {
            let hll = await readCSVForHLL(`${table}.csv`);
            return [{ 'APPROXIMATE_COUNT(*)': hll.estimate() }];
        }

        let data = await readCSV(`${table}.csv`);

        // Perform INNER JOIN if specified
        if (joinTable && joinCondition) {
            const joinData = await readCSV(`${joinTable}.csv`);
            switch (joinType.toUpperCase()) {
                case 'INNER':
                    data = performInnerJoin(data, joinData, joinCondition, fields, table);
                    break;
                case 'LEFT':
                    data = performLeftJoin(data, joinData, joinCondition, fields, table);
                    break;
                case 'RIGHT':
                    data = performRightJoin(data, joinData, joinCondition, fields, table);
                    break;
                default:
                    throw new Error(`Unsupported JOIN type: ${joinType}`);
            }
        }
        // Apply WHERE clause filtering after JOIN 
        let filteredData = whereClauses.length > 0
            ? data.filter(row => whereClauses.every(clause => evaluateCondition(row, clause)))
            : data;


        let groupResults = filteredData;
        if (hasAggregateWithoutGroupBy) {
            
            const result = {};

            fields.forEach(field => {
                const match = /(\w+)\((\*|\w+)\)/.exec(field);
                if (match) {
                    const [, aggFunc, aggField] = match;
                    switch (aggFunc.toUpperCase()) {
                        case 'COUNT':
                            result[field] = filteredData.length;
                            break;
                        case 'SUM':
                            result[field] = filteredData.reduce((acc, row) => acc + parseFloat(row[aggField]), 0);
                            break;
                        case 'AVG':
                            result[field] = filteredData.reduce((acc, row) => acc + parseFloat(row[aggField]), 0) / filteredData.length;
                            break;
                        case 'MIN':
                            result[field] = Math.min(...filteredData.map(row => parseFloat(row[aggField])));
                            break;
                        case 'MAX':
                            result[field] = Math.max(...filteredData.map(row => parseFloat(row[aggField])));
                            break;
                        
                    }
                }
            });

            return [result];
            
        } else if (groupByFields) {
            groupResults = applyGroupBy(filteredData, groupByFields, fields);

            
            let orderedResults = groupResults;
            if (orderByFields) {
                orderedResults = groupResults.sort((a, b) => {
                    for (let { fieldName, order } of orderByFields) {
                        if (a[fieldName] < b[fieldName]) return order === 'ASC' ? -1 : 1;
                        if (a[fieldName] > b[fieldName]) return order === 'ASC' ? 1 : -1;
                    }
                    return 0;
                });
            }
            if (limit !== null) {
                groupResults = groupResults.slice(0, limit);
            }
            return groupResults;
        } else {

            
            let orderedResults = groupResults;
            if (orderByFields) {
                orderedResults = groupResults.sort((a, b) => {
                    for (let { fieldName, order } of orderByFields) {
                        if (a[fieldName] < b[fieldName]) return order === 'ASC' ? -1 : 1;
                        if (a[fieldName] > b[fieldName]) return order === 'ASC' ? 1 : -1;
                    }
                    return 0;
                });
            }

            
            if (isCountDistinct) {

                if (isApproximateCount) {
                    var h = hll({ bitSampleSize: 12, digestSize: 128 });
                    orderedResults.forEach(row => h.insert(distinctFields.map(field => row[field]).join('|')));
                    return [{ [`APPROXIMATE_${fields[0]}`]: h.estimate() }];
                }
                else {
                    let distinctResults = [...new Map(orderedResults.map(item => [distinctFields.map(field => item[field]).join('|'), item])).values()];
                    return [{ [fields[0]]: distinctResults.length }];
                }
            }

            // Select the specified fields
            let finalResults = orderedResults.map(row => {
                const selectedRow = {};
                fields.forEach(field => {
                    
                    selectedRow[field] = row[field];
                });
                return selectedRow;
            });

            
            let distinctResults = finalResults;
            if (isDistinct) {
                distinctResults = [...new Map(finalResults.map(item => [fields.map(field => item[field]).join('|'), item])).values()];
            }

            let limitResults = distinctResults;
            if (limit !== null) {
                limitResults = distinctResults.slice(0, limit);
            }

            return limitResults;


        }
    } catch (error) {
        throw new Error(`Error executing query: ${error.message}`);
    }
}



module.exports = { executeSELECTQuery };