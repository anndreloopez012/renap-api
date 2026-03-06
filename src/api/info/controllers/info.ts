/**
 * info controller
 */

import { factories } from '@strapi/strapi';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

// ─── CSV Import helpers ───────────────────────────────────────────────────────

function csvParseLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (!inQuotes && ch === delimiter) {
      fields.push(current); current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function csvParseDateValue(value: string): string {
  const text = value.trim();
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      throw new Error(`Fecha invalida: ${value}`);
    }
    return dt.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  throw new Error(`Formato de fecha no soportado: ${value}`);
}

function csvCastValue(raw: string, type: string): unknown {
  const value = raw.trim();
  if (value === '') return null;
  if (type === 'biginteger') {
    if (!/^-?\d+$/.test(value)) throw new Error(`Biginteger invalido: ${value}`);
    return value;
  }
  if (type === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error(`Entero invalido: ${value}`);
    return n;
  }
  if (type === 'float' || type === 'decimal') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Numero invalido: ${value}`);
    return n;
  }
  if (type === 'boolean') {
    const v = value.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    throw new Error(`Booleano invalido: ${value}`);
  }
  if (type === 'date') return csvParseDateValue(value);
  if (type === 'datetime') {
    const dt = new Date(value);
    if (isNaN(dt.getTime())) throw new Error(`Datetime invalido: ${value}`);
    return dt.toISOString();
  }
  return value;
}

function csvDetectEncoding(filePath: string): BufferEncoding {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    // BOM detection
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8';
    // Check for invalid UTF-8 sequences
    try {
      new (require('util').TextDecoder)('utf-8', { fatal: true }).decode(buf);
      return 'utf8';
    } catch {
      return 'latin1';
    }
  } finally {
    fs.closeSync(fd);
  }
}

type QueryValue =
  | string
  | number
  | boolean
  | null
  | QueryValue[]
  | { [key: string]: QueryValue };

const sanitizeQuery = (query: unknown): QueryValue => {
  if (
    query === null ||
    typeof query === 'string' ||
    typeof query === 'number' ||
    typeof query === 'boolean'
  ) {
    return query as QueryValue;
  }

  if (Array.isArray(query)) {
    return query.map((value) => sanitizeQuery(value));
  }

  if (typeof query === 'object') {
    const entries = Object.entries(query as Record<string, unknown>).map(([key, value]) => [
      key,
      sanitizeQuery(value),
    ]);

    return Object.fromEntries(entries);
  }

  return String(query);
};

const toPositiveInt = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), max);
};

export default factories.createCoreController('api::info.info', ({ strapi }) => ({
  async find(ctx) {
    const response = await super.find(ctx);
    await this.logInfoQuery(ctx);

    return response;
  },

  async findOne(ctx) {
    const response = await super.findOne(ctx);
    await this.logInfoQuery(ctx);

    return response;
  },

  async search(ctx) {
    const term = String(ctx.query.q ?? '').trim();
    const limit = toPositiveInt(ctx.query.limit, 20, 100);
    const page = toPositiveInt(ctx.query.page, 1, 100000);
    const offset = (page - 1) * limit;

    if (!term) {
      return ctx.badRequest('Debes enviar el parametro q con el termino a buscar.');
    }

    const isNumericTerm = /^\d+$/.test(term);

    // ── Shared SELECT columns ─────────────────────────────────────────────────
    const SELECT_COLS = `
      id,
      document_id AS "documentId",
      cui AS "CUI",
      primer_nombre AS "PRIMER_NOMBRE",
      segundo_nombre AS "SEGUNDO_NOMBRE",
      tercer_nombre AS "TERCER_NOMBRE",
      primer_apellido AS "PRIMER_APELLIDO",
      segundo_apellido AS "SEGUNDO_APELLIDO",
      fecha_nacimiento AS "FECHA_NACIMIENTO",
      correo_electronico AS "CORREO_ELECTRONICO",
      telefono AS "TELEFONO",
      pais_residencia AS "PAIS_RESIDENCIA",
      depto_residencia AS "DEPTO_RESIDENCIA",
      munic_residencia AS "MUNIC_RESIDENCIA",
      direccion AS "DIRECCION",
      ws_mides AS "WS_MIDES",
      ws_maga AS "WS_MAGA",
      ws_mspas AS "WS_MSPAS",
      ws_mineco AS "WS_MINECO"
    `;

    let sql: string;
    let bindings: unknown[];

    if (isNumericTerm) {
      // ── CUI path: uses B-tree index on cui (biginteger) ──────────────────
      // Exact match is O(log n) → microseconds on 12M rows.
      // Prefix match uses the text cast; still very fast with index.
      const cuiBigInt = BigInt(term);
      const isFullCui = term.length >= 13;

      if (isFullCui) {
        // Exact CUI lookup — single row, instant
        sql = `
          SELECT ${SELECT_COLS}, 1 AS relevance
          FROM infos
          WHERE cui = ?
          ORDER BY id DESC
          LIMIT ? OFFSET ?
        `;
        bindings = [cuiBigInt.toString(), limit, offset];
      } else {
        // Prefix CUI: range between term*10^pad and (term+1)*10^pad - 1
        // Avoids text cast, stays on the B-tree numeric index
        const padLen = 13 - term.length;
        const pow = BigInt(10 ** padLen);
        const lo = BigInt(term) * pow;
        const hi = (BigInt(term) + BigInt(1)) * pow - BigInt(1);
        sql = `
          SELECT ${SELECT_COLS}, 1 AS relevance
          FROM infos
          WHERE cui BETWEEN ? AND ?
          ORDER BY cui ASC
          LIMIT ? OFFSET ?
        `;
        bindings = [lo.toString(), hi.toString(), limit, offset];
      }
    } else {
      // ── Name path: uses GIN trigram indexes ──────────────────────────────
      // idx_infos_fullname_trgm  covers the full concat expression
      // idx_infos_primer_nombre_trgm / primer_apellido / segundo_apellido
      // cover individual column lookups.
      //
      // The % operator uses GIN index for bitmap scan (very fast).
      // The LIKE '%term%' also uses GIN trigram index for terms >= 3 chars.
      const fullNameExpr = `lower(f_unaccent(trim(concat_ws(' ',
        primer_nombre, segundo_nombre, tercer_nombre,
        primer_apellido, segundo_apellido
      ))))`;

      sql = `
        SELECT
          ${SELECT_COLS},
          similarity(${fullNameExpr}, lower(f_unaccent(?))) AS relevance
        FROM infos
        WHERE
          ${fullNameExpr} % lower(f_unaccent(?))
          OR ${fullNameExpr} LIKE '%' || lower(f_unaccent(?)) || '%'
          OR lower(f_unaccent(coalesce(primer_nombre, '')))    % lower(f_unaccent(?))
          OR lower(f_unaccent(coalesce(primer_apellido, '')))  % lower(f_unaccent(?))
          OR lower(f_unaccent(coalesce(segundo_apellido, ''))) % lower(f_unaccent(?))
        ORDER BY
          CASE
            WHEN ${fullNameExpr} = lower(f_unaccent(?))       THEN 0
            WHEN ${fullNameExpr} % lower(f_unaccent(?))       THEN 1
            ELSE 2
          END,
          relevance DESC,
          id DESC
        LIMIT ? OFFSET ?
      `;
      bindings = [
        term, // similarity() SELECT
        term, // fullname %
        term, // fullname LIKE
        term, // primer_nombre %
        term, // primer_apellido %
        term, // segundo_apellido %
        term, // ORDER CASE exact
        term, // ORDER CASE similarity
        limit,
        offset,
      ];
    }

    const rawResult = await strapi.db.connection.raw(sql, bindings);
    const rows = Array.isArray(rawResult?.rows)
      ? rawResult.rows
      : Array.isArray(rawResult?.[0])
        ? rawResult[0]
        : [];

    await this.logInfoQuery(ctx);

    return {
      data: rows,
      meta: {
        pagination: {
          page,
          pageSize: limit,
          count: rows.length,
        },
        query: term,
      },
    };
  },

  async import(ctx) {
    const files = (ctx.request as any).files;
    const file = files?.file;

    if (!file) {
      ctx.status = 400;
      ctx.body = { error: 'Debes subir un archivo CSV con el campo "file".' };
      return;
    }

    const filePath: string = file.filepath ?? file.path;
    if (!filePath || !fs.existsSync(filePath)) {
      ctx.status = 400;
      ctx.body = { error: 'No se pudo acceder al archivo subido.' };
      return;
    }

    const body = (ctx.request as any).body ?? {};
    const delimiter = (String(body.delimiter ?? ';').trim()[0]) ?? ';';
    const encodingParam = String(body.encoding ?? 'auto').toLowerCase();
    const fileEncoding: BufferEncoding =
      encodingParam === 'auto' ? csvDetectEncoding(filePath) :
      encodingParam === 'latin1' ? 'latin1' : 'utf8';

    // ── SSE setup ─────────────────────────────────────────────────────────────
    ctx.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    ctx.status = 200;
    ctx.respond = false;

    const res = ctx.res;
    const send = (data: object) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };

    // Keepalive para evitar timeout en proxies
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 15_000);

    const BATCH_SIZE = 2000;
    const PROGRESS_EVERY = 10_000;
    const stats = { processed: 0, inserted: 0, failed: 0, skipped: 0 };
    const startedAt = Date.now();

    try {
      const contentType = strapi.contentTypes['api::info.info'];
      const attributes: Record<string, { type: string }> = (contentType?.attributes ?? {}) as any;
      const validColumns = Object.keys(attributes);

      send({ type: 'start', encoding: fileEncoding, message: `Iniciando importacion (encoding: ${fileEncoding})...` });

      const stream = fs.createReadStream(filePath, { encoding: fileEncoding, highWaterMark: 8 * 1024 * 1024 });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let headers: string[] | null = null;
      let lineNumber = 0;
      let batch: Record<string, unknown>[] = [];

      const flushBatch = async () => {
        if (batch.length === 0) return;
        try {
          await strapi.db.query('api::info.info').createMany({ data: batch });
          stats.inserted += batch.length;
        } catch {
          // Bisect to identify individual failing rows
          const isolate = async (rows: Record<string, unknown>[]) => {
            if (rows.length === 1) {
              stats.failed++;
              send({ type: 'rowError', message: `Fila con error omitida` });
              return;
            }
            const mid = Math.floor(rows.length / 2);
            try {
              await strapi.db.query('api::info.info').createMany({ data: rows.slice(0, mid) });
              stats.inserted += mid;
            } catch { await isolate(rows.slice(0, mid)); }
            try {
              await strapi.db.query('api::info.info').createMany({ data: rows.slice(mid) });
              stats.inserted += rows.length - mid;
            } catch { await isolate(rows.slice(mid)); }
          };
          await isolate(batch);
        }
        batch = [];
      };

      for await (const rawLine of rl) {
        lineNumber++;
        const line = (rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
          .replace(/&quot;/gi, "'").replace(/&amp;/gi, '&').replace(/&apos;/gi, "'");

        if (!headers) {
          if (!line.trim()) continue;
          headers = csvParseLine(line, delimiter).map((h) => h.trim().replace(/^\uFEFF/, ''));
          const unknown = headers.filter((h) => h && !validColumns.includes(h));
          if (unknown.length > 0) {
            send({ type: 'error', message: `Columnas desconocidas en el CSV: ${unknown.join(', ')}` });
            clearInterval(keepalive);
            try { res.end(); } catch (_) {}
            return;
          }
          send({ type: 'headers', columns: headers, message: `Columnas: ${headers.join(', ')}` });
          continue;
        }

        if (!line.trim()) { stats.skipped++; continue; }

        let cols: string[];
        try { cols = csvParseLine(line, delimiter); }
        catch { stats.failed++; continue; }

        // Trim trailing empty columns to match header length
        while (cols.length > headers.length && cols[cols.length - 1].trim() === '') cols.pop();
        if (cols.length !== headers.length) { stats.failed++; continue; }

        const row: Record<string, unknown> = {};
        let parseError = false;
        for (let i = 0; i < headers.length; i++) {
          const field = headers[i];
          const attr = attributes[field];
          if (!attr) continue;
          try { row[field] = csvCastValue(cols[i], attr.type); }
          catch { stats.failed++; parseError = true; break; }
        }
        if (parseError) continue;

        batch.push(row);
        stats.processed++;

        if (batch.length >= BATCH_SIZE) await flushBatch();

        if (stats.processed % PROGRESS_EVERY === 0) {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = Math.round(stats.processed / Math.max(elapsed, 1));
          send({ type: 'progress', ...stats, rate, elapsed: elapsed.toFixed(1) });
        }
      }

      await flushBatch();

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      send({ type: 'complete', ...stats, elapsed, message: 'Importacion finalizada correctamente.' });
    } catch (err) {
      send({ type: 'error', message: `Error fatal: ${String(err)}` });
    } finally {
      clearInterval(keepalive);
      try { res.end(); } catch (_) {}
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  },

  // ── Chunked upload: recibe un fragmento del CSV ─────────────────────────────
  async importChunk(ctx) {
    const files = (ctx.request as any).files;
    const chunk = files?.chunk;
    const body = (ctx.request as any).body ?? {};
    const uploadId = String(body.uploadId ?? '').trim().replace(/[^a-zA-Z0-9-]/g, '');
    const chunkIndex = Number(body.chunkIndex ?? 0);
    const totalChunks = Number(body.totalChunks ?? 1);

    if (!chunk || !uploadId) {
      ctx.status = 400;
      ctx.body = { error: 'Faltan parámetros: chunk, uploadId' };
      return;
    }

    const chunkPath: string = chunk.filepath ?? chunk.path;
    if (!chunkPath || !fs.existsSync(chunkPath)) {
      ctx.status = 400;
      ctx.body = { error: 'No se pudo leer el chunk.' };
      return;
    }

    const uploadDir = path.join(os.tmpdir(), `csv-import-${uploadId}`);
    fs.mkdirSync(uploadDir, { recursive: true });

    // Guardar chunk con nombre ordenado para ensamblar en orden
    const destChunk = path.join(uploadDir, `chunk-${String(chunkIndex).padStart(6, '0')}`);
    fs.renameSync(chunkPath, destChunk);

    const received = fs.readdirSync(uploadDir).filter((f) => f.startsWith('chunk-')).length;

    ctx.body = {
      status: received >= totalChunks ? 'ready' : 'received',
      uploadId,
      chunkIndex,
      received,
      total: totalChunks,
    };
  },

  // ── Procesar CSV ensamblado desde chunks → SSE ───────────────────────────────
  async importProcess(ctx) {
    const body = (ctx.request as any).body ?? {};
    const uploadId = String(body.uploadId ?? '').trim().replace(/[^a-zA-Z0-9-]/g, '');
    const totalChunks = Number(body.totalChunks ?? 0);
    const delimiter = (String(body.delimiter ?? ';').trim()[0]) ?? ';';
    const encodingParam = String(body.encoding ?? 'auto').toLowerCase();

    if (!uploadId || totalChunks <= 0) {
      ctx.status = 400;
      ctx.body = { error: 'Faltan parámetros: uploadId, totalChunks' };
      return;
    }

    const uploadDir = path.join(os.tmpdir(), `csv-import-${uploadId}`);
    const mergedPath = path.join(uploadDir, 'merged.csv');

    // Validar que todos los chunks existen
    for (let i = 0; i < totalChunks; i++) {
      const cp = path.join(uploadDir, `chunk-${String(i).padStart(6, '0')}`);
      if (!fs.existsSync(cp)) {
        ctx.status = 400;
        ctx.body = { error: `Chunk ${i} no encontrado. Reinicia la subida.` };
        return;
      }
    }

    // ── SSE setup ──────────────────────────────────────────────────────────────
    ctx.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    ctx.status = 200;
    ctx.respond = false;

    const res = ctx.res;
    const send = (data: object) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 15_000);

    const cleanup = () => {
      clearInterval(keepalive);
      try { res.end(); } catch (_) {}
      try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch (_) {}
    };

    try {
      // 1. Ensamblar chunks en un solo archivo
      send({ type: 'assembling', message: `Ensamblando ${totalChunks} fragmentos...` });

      const writeStream = fs.createWriteStream(mergedPath);
      for (let i = 0; i < totalChunks; i++) {
        const cp = path.join(uploadDir, `chunk-${String(i).padStart(6, '0')}`);
        await new Promise<void>((resolve, reject) => {
          const rs = fs.createReadStream(cp);
          rs.on('error', reject);
          rs.on('end', () => { try { fs.unlinkSync(cp); } catch (_) {} resolve(); });
          rs.pipe(writeStream, { end: false });
        });
      }
      await new Promise<void>((resolve) => writeStream.end(resolve));

      // 2. Detectar encoding
      const fileEncoding: BufferEncoding =
        encodingParam === 'auto' ? csvDetectEncoding(mergedPath) :
        encodingParam === 'latin1' ? 'latin1' : 'utf8';

      send({ type: 'start', encoding: fileEncoding, message: `Iniciando importacion (encoding: ${fileEncoding})...` });

      // 3. Procesar CSV (misma lógica que import())
      const contentType = strapi.contentTypes['api::info.info'];
      const attributes: Record<string, { type: string }> = (contentType?.attributes ?? {}) as any;
      const validColumns = Object.keys(attributes);

      const stream = fs.createReadStream(mergedPath, { encoding: fileEncoding, highWaterMark: 8 * 1024 * 1024 });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      const BATCH_SIZE = 2000;
      const PROGRESS_EVERY = 10_000;
      const stats = { processed: 0, inserted: 0, failed: 0, skipped: 0 };
      const startedAt = Date.now();
      let headers: string[] | null = null;
      let batch: Record<string, unknown>[] = [];

      const flushBatch = async () => {
        if (batch.length === 0) return;
        try {
          await strapi.db.query('api::info.info').createMany({ data: batch });
          stats.inserted += batch.length;
        } catch {
          const isolate = async (rows: Record<string, unknown>[]) => {
            if (rows.length === 1) { stats.failed++; send({ type: 'rowError', message: 'Fila omitida por error' }); return; }
            const mid = Math.floor(rows.length / 2);
            try { await strapi.db.query('api::info.info').createMany({ data: rows.slice(0, mid) }); stats.inserted += mid; } catch { await isolate(rows.slice(0, mid)); }
            try { await strapi.db.query('api::info.info').createMany({ data: rows.slice(mid) }); stats.inserted += rows.length - mid; } catch { await isolate(rows.slice(mid)); }
          };
          await isolate(batch);
        }
        batch = [];
      };

      for await (const rawLine of rl) {
        const line = (rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
          .replace(/&quot;/gi, "'").replace(/&amp;/gi, '&').replace(/&apos;/gi, "'");

        if (!headers) {
          if (!line.trim()) continue;
          headers = csvParseLine(line, delimiter).map((h) => h.trim().replace(/^\uFEFF/, ''));
          const unknown = headers.filter((h) => h && !validColumns.includes(h));
          if (unknown.length > 0) { send({ type: 'error', message: `Columnas desconocidas: ${unknown.join(', ')}` }); cleanup(); return; }
          send({ type: 'headers', columns: headers, message: `Columnas: ${headers.join(', ')}` });
          continue;
        }

        if (!line.trim()) { stats.skipped++; continue; }

        let cols: string[];
        try { cols = csvParseLine(line, delimiter); } catch { stats.failed++; continue; }

        while (cols.length > headers.length && cols[cols.length - 1].trim() === '') cols.pop();
        if (cols.length !== headers.length) { stats.failed++; continue; }

        const row: Record<string, unknown> = {};
        let parseError = false;
        for (let i = 0; i < headers.length; i++) {
          const attr = attributes[headers[i]];
          if (!attr) continue;
          try { row[headers[i]] = csvCastValue(cols[i], attr.type); }
          catch { stats.failed++; parseError = true; break; }
        }
        if (parseError) continue;

        batch.push(row);
        stats.processed++;

        if (batch.length >= BATCH_SIZE) await flushBatch();

        if (stats.processed % PROGRESS_EVERY === 0) {
          const elapsed = (Date.now() - startedAt) / 1000;
          send({ type: 'progress', ...stats, rate: Math.round(stats.processed / Math.max(elapsed, 1)), elapsed: elapsed.toFixed(1) });
        }
      }

      await flushBatch();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      send({ type: 'complete', ...stats, elapsed, message: 'Importacion finalizada correctamente.' });
    } catch (err) {
      send({ type: 'error', message: `Error fatal: ${String(err)}` });
    } finally {
      cleanup();
    }
  },

  async logInfoQuery(ctx) {
    try {
      const authenticatedUser = ctx.state.user;
      const userLabel =
        authenticatedUser?.username ||
        authenticatedUser?.email ||
        (authenticatedUser?.id ? `user-${authenticatedUser.id}` : 'anonymous');

      await strapi.entityService.create('api::info-log.info-log', {
        data: {
          searchedAt: new Date().toISOString(),
          userLabel,
          searchFilters: sanitizeQuery(ctx.query),
          requestPath: ctx.request.path,
          requestMethod: ctx.request.method,
          user: authenticatedUser?.id ?? null,
        },
      });
    } catch (error) {
      strapi.log.warn(`No se pudo guardar log de consulta de info: ${String(error)}`);
    }
  },
}));
