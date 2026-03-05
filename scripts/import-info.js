#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { TextDecoder } = require('util');
const core = require('@strapi/core');

const UID = 'api::info.info';
const DEFAULT_DELIMITER = ';';
const DEFAULT_BATCH_SIZE = 5000;
const PROGRESS_EVERY = 25000;

function parseArgs(argv) {
  const args = {
    delimiter: DEFAULT_DELIMITER,
    batchSize: DEFAULT_BATCH_SIZE,
    encoding: 'auto',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--file' || token === '-f') {
      args.file = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--delimiter' || token === '-d') {
      args.delimiter = argv[i + 1] || DEFAULT_DELIMITER;
      i += 1;
      continue;
    }

    if (token === '--batch-size' || token === '-b') {
      args.batchSize = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (token === '--encoding' || token === '-e') {
      args.encoding = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    throw new Error(`Parametro no reconocido: ${token}`);
  }

  if (args.help) {
    return args;
  }

  if (!args.file) {
    throw new Error('Debes indicar --file con la ruta del CSV');
  }

  if (!Number.isInteger(args.batchSize) || args.batchSize <= 0) {
    throw new Error('--batch-size debe ser un entero positivo');
  }

  if (!args.delimiter || args.delimiter.length !== 1) {
    throw new Error('--delimiter debe ser un solo caracter');
  }

  if (!args.encoding) {
    throw new Error('--encoding no puede estar vacio');
  }

  return args;
}

function printHelp() {
  console.log(`\nImportador masivo para api::info.info\n\nUso:\n  node scripts/import-info.js --file /ruta/archivo.csv [opciones]\n\nOpciones:\n  -f, --file         Ruta del archivo a importar (requerido)\n  -d, --delimiter    Delimitador de columnas (default: ;)\n  -b, --batch-size   Tamano de lote para insercion (default: 5000)\n  -e, --encoding     Codificacion de archivo: auto|utf8|latin1 (default: auto)\n      --dry-run      Solo valida y parsea, no inserta en DB\n  -h, --help         Muestra esta ayuda\n`);
}

function normalizeEncoding(encoding) {
  const value = String(encoding || '')
    .trim()
    .toLowerCase();

  if (value === 'auto') return 'auto';
  if (value === 'utf8' || value === 'utf-8') return 'utf8';
  if (value === 'latin1' || value === 'iso-8859-1' || value === 'windows-1252' || value === 'win1252') {
    return 'latin1';
  }

  throw new Error(`Encoding no soportado: ${encoding}. Usa auto, utf8 o latin1`);
}

function detectFileEncoding(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const sampleSize = 256 * 1024;
    const offsets = [0, Math.floor(size / 3), Math.floor((2 * size) / 3)];

    let hasUtf8Bom = false;
    let hasInvalidUtf8 = false;

    for (const offset of offsets) {
      const buffer = Buffer.alloc(sampleSize);
      const safeOffset = Math.max(0, Math.min(offset, Math.max(0, size - sampleSize)));
      const bytesRead = fs.readSync(fd, buffer, 0, sampleSize, safeOffset);
      const sample = buffer.subarray(0, bytesRead);

      if (safeOffset === 0 && sample.length >= 3) {
        if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
          hasUtf8Bom = true;
        }
      }

      try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample);
      } catch (_error) {
        hasInvalidUtf8 = true;
        break;
      }
    }

    if (hasUtf8Bom) {
      return 'utf8';
    }

    if (hasInvalidUtf8) {
      return 'latin1';
    }

    return 'utf8';
  } finally {
    fs.closeSync(fd);
  }
}

function parseDelimitedLine(line, delimiter) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else if (inQuotes || current.length === 0) {
        inQuotes = !inQuotes;
      } else {
        current += char;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);

  if (inQuotes) {
    throw new Error('Linea con comillas sin cerrar');
  }

  return fields;
}

function normalizeHeader(rawHeader) {
  return rawHeader.map((value) => value.trim().replace(/^\uFEFF/, ''));
}

function sanitizeRawLine(rawLine) {
  return rawLine
    .replace(/&quot;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function adjustColumnsLength(columns, expectedLength) {
  if (columns.length <= expectedLength) {
    return columns;
  }

  const adjusted = [...columns];
  while (adjusted.length > expectedLength) {
    const last = adjusted[adjusted.length - 1];
    if (String(last).trim() !== '') {
      break;
    }
    adjusted.pop();
  }

  return adjusted;
}

function parseDateValue(value) {
  const text = String(value).trim();

  const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;
  const ddmmyyyyMatch = text.match(ddmmyyyy);
  if (ddmmyyyyMatch) {
    const day = Number(ddmmyyyyMatch[1]);
    const month = Number(ddmmyyyyMatch[2]);
    const year = Number(ddmmyyyyMatch[3]);

    const date = new Date(Date.UTC(year, month - 1, day));
    const isValid =
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;

    if (!isValid) {
      throw new Error(`Fecha invalida: ${value}`);
    }

    return date.toISOString().slice(0, 10);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/;
  const isoMatch = text.match(iso);
  if (isoMatch) {
    return text;
  }

  throw new Error(`Formato de fecha no soportado: ${value}`);
}

function castValue(rawValue, type) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;

  if (value === '') {
    return null;
  }

  if (type === 'integer') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new Error(`Valor entero invalido: ${value}`);
    }
    return parsed;
  }

  if (type === 'biginteger') {
    const normalized = String(value).trim();
    if (!/^-?\d+$/.test(normalized)) {
      throw new Error(`Valor biginteger invalido: ${value}`);
    }
    return normalized;
  }

  if (type === 'float' || type === 'decimal') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Valor numerico invalido: ${value}`);
    }
    return parsed;
  }

  if (type === 'boolean') {
    const normalized = String(value).toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    throw new Error(`Valor booleano invalido: ${value}`);
  }

  if (type === 'date' || type === 'datetime') {
    if (type === 'date') {
      return parseDateValue(value);
    }

    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Fecha/hora invalida: ${value}`);
    }
    return date.toISOString();
  }

  return value;
}

async function createStrapiApp() {
  const appContext = await core.compileStrapi();
  return core.createStrapi(appContext).load();
}

function loadInfoAttributesFromSchema() {
  const schemaPath = path.join(
    process.cwd(),
    'src',
    'api',
    'info',
    'content-types',
    'info',
    'schema.json'
  );

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`No existe schema local de info en: ${schemaPath}`);
  }

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  return schema.attributes || {};
}

async function flushBatch(strapi, batch, stats, errorFile, dryRun) {
  if (batch.length === 0) {
    return;
  }

  if (dryRun) {
    stats.inserted += batch.length;
    return;
  }

  try {
    await strapi.db.query(UID).createMany({ data: batch });
    stats.inserted += batch.length;
  } catch (error) {
    await isolateBatchError(strapi, batch, stats, errorFile, error, dryRun);
  }
}

async function isolateBatchError(strapi, batch, stats, errorFile, error, dryRun) {
  if (batch.length === 1) {
    stats.failed += 1;
    const payload = {
      line: batch[0].__line,
      error: String(error.message || error),
      row: batch[0],
    };
    delete payload.row.__line;
    fs.appendFileSync(errorFile, `${JSON.stringify(payload)}\n`);
    return;
  }

  const middle = Math.floor(batch.length / 2);
  const left = batch.slice(0, middle);
  const right = batch.slice(middle);

  await flushBatch(strapi, left, stats, errorFile, dryRun);
  await flushBatch(strapi, right, stats, errorFile, dryRun);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const absolutePath = path.resolve(args.file);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`No existe el archivo: ${absolutePath}`);
  }

  const errorsDir = path.join(process.cwd(), '.tmp', 'import-errors');
  fs.mkdirSync(errorsDir, { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const errorFile = path.join(errorsDir, `info-import-${stamp}.errors.ndjson`);

  console.log(`[import-info] Archivo: ${absolutePath}`);
  console.log(`[import-info] Delimitador: "${args.delimiter}"`);
  console.log(`[import-info] Batch size: ${args.batchSize}`);
  console.log(`[import-info] Modo: ${args.dryRun ? 'dry-run' : 'insercion real'}`);

  const selectedEncoding = normalizeEncoding(args.encoding);
  const fileEncoding =
    selectedEncoding === 'auto' ? detectFileEncoding(absolutePath) : selectedEncoding;
  console.log(`[import-info] Encoding detectado/usado: ${fileEncoding}`);

  const strapi = args.dryRun ? null : await createStrapiApp();
  const startedAt = Date.now();

  try {
    let attributes;

    if (args.dryRun) {
      attributes = loadInfoAttributesFromSchema();
    } else {
      const contentType = strapi.contentTypes[UID];
      if (!contentType) {
        throw new Error(`No existe el content-type ${UID}`);
      }
      attributes = contentType.attributes || {};
    }

    const validColumns = Object.keys(attributes);

    const stream = fs.createReadStream(absolutePath, {
      encoding: fileEncoding,
      highWaterMark: 8 * 1024 * 1024,
    });

    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let headers = null;
    let lineNumber = 0;
    const stats = {
      processed: 0,
      inserted: 0,
      failed: 0,
      skipped: 0,
    };

    let batch = [];

    for await (const rawLine of rl) {
      lineNumber += 1;
      const line = sanitizeRawLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);

      if (line.includes('�')) {
        throw new Error(
          `Se detectaron caracteres invalidos en linea ${lineNumber}. ` +
            'Reintenta con --encoding latin1 para preservar tildes y caracteres especiales.'
        );
      }

      if (!headers) {
        if (!line.trim()) {
          continue;
        }

        const parsedHeaders = normalizeHeader(parseDelimitedLine(line, args.delimiter));
        const headerColumns = adjustColumnsLength(parsedHeaders, parsedHeaders.length).filter(
          (header) => header !== ''
        );
        const unknownHeaders = headerColumns.filter((header) => !validColumns.includes(header));

        if (unknownHeaders.length > 0) {
          throw new Error(
            `El archivo contiene columnas que no existen en info: ${unknownHeaders.join(', ')}`
          );
        }

        headers = headerColumns;
        console.log(`[import-info] Encabezados detectados: ${headers.join(', ')}`);
        continue;
      }

      if (!line.trim()) {
        stats.skipped += 1;
        continue;
      }

      let columns;
      try {
        columns = parseDelimitedLine(line, args.delimiter);
        columns = adjustColumnsLength(columns, headers.length);
      } catch (error) {
        stats.failed += 1;
        fs.appendFileSync(
          errorFile,
          `${JSON.stringify({ line: lineNumber, error: String(error.message || error) })}\n`
        );
        continue;
      }

      if (columns.length !== headers.length) {
        stats.failed += 1;
        fs.appendFileSync(
          errorFile,
          `${JSON.stringify({
            line: lineNumber,
            error: `Cantidad de columnas invalida. Esperadas=${headers.length}, recibidas=${columns.length}`,
          })}\n`
        );
        continue;
      }

      const row = { __line: lineNumber };

      try {
        for (let i = 0; i < headers.length; i += 1) {
          const fieldName = headers[i];
          const attribute = attributes[fieldName];

          if (!attribute) {
            continue;
          }

          row[fieldName] = castValue(columns[i], attribute.type);
        }
      } catch (error) {
        stats.failed += 1;
        fs.appendFileSync(
          errorFile,
          `${JSON.stringify({ line: lineNumber, error: String(error.message || error) })}\n`
        );
        continue;
      }

      batch.push(row);
      stats.processed += 1;

      if (batch.length >= args.batchSize) {
        await flushBatch(strapi, batch, stats, errorFile, args.dryRun);
        batch = [];
      }

      if (stats.processed % PROGRESS_EVERY === 0) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rate = Math.round(stats.processed / Math.max(elapsedSec, 1));
        console.log(
          `[import-info] Procesadas=${stats.processed} Insertadas=${stats.inserted} Fallidas=${stats.failed} Velocidad=${rate} filas/s`
        );
      }
    }

    await flushBatch(strapi, batch, stats, errorFile, args.dryRun);

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('[import-info] Proceso finalizado');
    console.log(`[import-info] Tiempo total: ${elapsedSec}s`);
    console.log(`[import-info] Filas procesadas: ${stats.processed}`);
    console.log(`[import-info] Filas insertadas: ${stats.inserted}`);
    console.log(`[import-info] Filas fallidas: ${stats.failed}`);
    console.log(`[import-info] Filas vacias omitidas: ${stats.skipped}`);
    console.log(`[import-info] Log de errores: ${errorFile}`);
  } finally {
    if (strapi) {
      await strapi.destroy();
    }
  }
}

main().catch((error) => {
  console.error(`[import-info] Error fatal: ${error.message}`);
  process.exitCode = 1;
});
