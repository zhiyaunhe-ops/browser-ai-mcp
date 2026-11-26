'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);
const error = (code, message) => Object.assign(new Error(message), { code });

function sqlText(value) {
  if (!value.trim() || value.length > 128) throw error('DB_SCHEMA_ARGUMENTS', 'Provide a search term or identifier of 1 to 128 characters.');
  return 'CONVERT(nvarchar(128),0x' + Buffer.from(value,'utf16le').toString('hex') + ')';
}

const tables = 'FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id';
const tableNote = "LEFT JOIN sys.extended_properties td ON td.class=1 AND td.major_id=t.object_id AND td.minor_id=0 AND td.name=N'MS_Description'";
const columns = 'FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id';
const columnNote = "LEFT JOIN sys.extended_properties cd ON cd.class=1 AND cd.major_id=c.object_id AND cd.minor_id=c.column_id AND cd.name=N'MS_Description'";
const fields = `c.name,c.column_id AS ordinal,ty.name AS type,SCHEMA_NAME(ty.schema_id) AS typeSchema,c.max_length AS maxLengthBytes,
  c.precision,c.scale,c.is_nullable AS nullable,c.is_identity AS [identity],c.is_computed AS computed,CONVERT(nvarchar(4000),cd.value) AS description`;

function tableQuery(schema, name) {
  return `SELECT s.name AS [schema],t.name,CONVERT(nvarchar(4000),td.value) AS description,
    JSON_QUERY((SELECT ${fields} ${columns} ${columnNote} WHERE c.object_id=t.object_id ORDER BY c.column_id FOR JSON PATH)) AS columns,
    JSON_QUERY((SELECT i.name,i.type_desc AS indexType,i.is_primary_key AS primaryKey,i.is_unique AS isUnique,
      k.key_ordinal AS keyOrdinal,k.is_included_column AS included,k.is_descending_key AS descending,COL_NAME(k.object_id,k.column_id) AS columnName
      FROM sys.indexes i JOIN sys.index_columns k ON k.object_id=i.object_id AND k.index_id=i.index_id
      WHERE i.object_id=t.object_id AND i.index_id>0 AND i.is_hypothetical=0 ORDER BY i.index_id,k.index_column_id FOR JSON PATH)) AS indexes,
    JSON_QUERY((SELECT f.name,k.constraint_column_id AS position,OBJECT_SCHEMA_NAME(f.parent_object_id) AS childSchema,
      OBJECT_NAME(f.parent_object_id) AS childTable,COL_NAME(f.parent_object_id,k.parent_column_id) AS childColumn,
      OBJECT_SCHEMA_NAME(f.referenced_object_id) AS parentSchema,OBJECT_NAME(f.referenced_object_id) AS parentTable,
      COL_NAME(f.referenced_object_id,k.referenced_column_id) AS parentColumn,f.is_disabled AS disabled,f.is_not_trusted AS untrusted
      FROM sys.foreign_keys f JOIN sys.foreign_key_columns k ON k.constraint_object_id=f.object_id
      WHERE f.parent_object_id=t.object_id OR f.referenced_object_id=t.object_id ORDER BY f.object_id,k.constraint_column_id FOR JSON PATH)) AS foreignKeys
    ${tables} ${tableNote} WHERE t.is_ms_shipped=0 AND s.name=${sqlText(schema)} AND t.name=${sqlText(name)}`;
}

async function liveQuery(query) {
  if (!process.env.BROWSER_AI_SCHEMA_CONNECTION) throw error('DB_SCHEMA_SETUP','Set BROWSER_AI_SCHEMA_CONNECTION to a read-only SQL Server connection string.');
  const sql = `SELECT (SELECT DB_NAME() AS databaseName,SYSUTCDATETIME() AS queriedAt,JSON_QUERY((${query} FOR JSON PATH)) AS items FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS payload`;
  try {
    const {stdout} = await run('pwsh', ['-NoProfile','-NonInteractive','-File',path.join(__dirname,'schema-read.ps1')], {
      timeout:45000,windowsHide:true,maxBuffer:8*1024*1024,env:{...process.env,BROWSER_AI_SCHEMA_QUERY:sql}
    });
    return JSON.parse(stdout);
  } catch { throw error('DB_SCHEMA_READ','Could not read metadata from the configured database.'); }
}

async function readSchema(argv, queryCatalog = liveQuery) {
  const [action,term='',third,fourth] = argv;
  let query, offset, limit;
  if (action==='table' && argv.length===3) query=tableQuery(term,third);
  else if (action==='info' && argv.length===1) query='SELECT 1 AS connected';
  else if (['tables','columns'].includes(action) && argv.length<=4) {
    const search=sqlText(term);
    offset=Number(third??0); limit=Number(fourth??50);
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200) throw error('DB_SCHEMA_ARGUMENTS','Check offset and limit (1–200).');
    query=action==='tables'
      ? `SELECT s.name AS schemaName,t.name,CONVERT(nvarchar(4000),td.value) AS description,
        (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id=t.object_id) AS columnCount ${tables} ${tableNote}
        WHERE t.is_ms_shipped=0 AND (CHARINDEX(${search},t.name)>0 OR CHARINDEX(${search},CONVERT(nvarchar(4000),td.value))>0) ORDER BY s.name,t.name`
      : `SELECT s.name AS schemaName,t.name AS tableName,${fields} ${columns} JOIN sys.tables t ON t.object_id=c.object_id
        JOIN sys.schemas s ON s.schema_id=t.schema_id ${columnNote} WHERE t.is_ms_shipped=0 AND
        (CHARINDEX(${search},c.name)>0 OR CHARINDEX(${search},CONVERT(nvarchar(4000),cd.value))>0) ORDER BY s.name,t.name,c.column_id`;
    query+=` OFFSET ${offset} ROWS FETCH NEXT ${limit+1} ROWS ONLY`;
  } else throw error('DB_SCHEMA_ARGUMENTS','Use info, table with schema and table name, or tables/columns with a search term.');
  const {items=[],...source}=await queryCatalog(query);
  if (action==='info') return source;
  if (action==='table') {
    if (!items.length) throw error('DB_SCHEMA_TABLE','No matching table in this database.');
    return {source,columns:[],indexes:[],foreignKeys:[],...items[0]};
  }
  return {source,items:items.slice(0,limit),nextOffset:items.length>limit?offset+limit:null};
}

module.exports = { readSchema };
