import type { Core } from '@strapi/strapi';
import geoip from 'geoip-lite';

// ─── Cache en memoria ─────────────────────────────────────────────────────────
let whitelist = new Set<string>();
let blacklist = new Set<string>();
let regionBlock = new Set<string>();
let cacheLastRefresh = 0;
const CACHE_TTL_MS = 60_000; // refresca cada 60 segundos

// ─── Rate limiting ────────────────────────────────────────────────────────────
interface RateEntry { count: number; resetAt: number }
const rateLimitMap = new Map<string, RateEntry>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 100;

// ─── Rastreo de 404 sospechosos ────────────────────────────────────────────────
const notFoundMap = new Map<string, RateEntry>();
const NOT_FOUND_MAX = 20;

// ─── Patrones de ataque conocidos ─────────────────────────────────────────────
const ATTACK_PATTERNS: RegExp[] = [
  // SQL Injection
  /(\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bdrop\b|\bunion\b).{0,30}(\bfrom\b|\binto\b|\bwhere\b|\btable\b)/i,
  // Path traversal
  /\.\.[/\\]/,
  // XSS
  /<script[\s>]/i,
  /javascript:/i,
  // Command injection
  /[;&|`$].*\b(bash|sh|cmd|powershell|wget|curl|nc|ncat|python|perl|ruby)\b/i,
  // Archivo sensible de Linux
  /\/etc\/(passwd|shadow|hosts|crontab)/i,
  // Herramientas de escaneo comunes
  /\/(wp-admin|wp-login|phpmyadmin|\.env|\.git\/config|\.aws\/credentials|actuator\/env)/i,
  // eval/exec
  /\b(eval|exec|system|passthru|shell_exec)\s*\(/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getClientIp = (ctx: any): string => {
  const forwarded = ctx.request.headers['x-forwarded-for'] as string | undefined;
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = ctx.request.headers['x-real-ip'] as string | undefined;
  if (realIp) return realIp.trim();
  return ctx.request.ip ?? '0.0.0.0';
};

const incrementCounter = (map: Map<string, RateEntry>, ip: string, windowMs: number): number => {
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || now > entry.resetAt) {
    map.set(ip, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  entry.count += 1;
  return entry.count;
};

const hasAttackPattern = (ctx: any): string | null => {
  const path = ctx.request.path ?? '';
  const query = ctx.request.querystring ?? '';
  const combined = decodeURIComponent(`${path}?${query}`);
  for (const pattern of ATTACK_PATTERNS) {
    if (pattern.test(combined)) return pattern.toString();
  }
  return null;
};

// ─── Cache DB ─────────────────────────────────────────────────────────────────

const refreshCache = async (strapi: Core.Strapi): Promise<void> => {
  const now = Date.now();
  if (now - cacheLastRefresh < CACHE_TTL_MS) return;
  cacheLastRefresh = now;

  try {
    const [wlEntries, blEntries, rbEntries] = await Promise.all([
      strapi.entityService.findMany('api::ip-whitelist.ip-whitelist', {
        filters: { active: true },
        fields: ['ip'],
        pagination: { pageSize: 1000 },
      }),
      strapi.entityService.findMany('api::ip-blacklist.ip-blacklist', {
        filters: { active: true },
        fields: ['ip', 'expiresAt'],
        pagination: { pageSize: 5000 },
      }),
      strapi.entityService.findMany('api::region-block.region-block', {
        filters: { active: true },
        fields: ['countryCode'],
        pagination: { pageSize: 300 },
      }),
    ]);

    const now = new Date();

    whitelist = new Set((wlEntries as any[]).map((e) => e.ip as string));

    blacklist = new Set(
      (blEntries as any[])
        .filter((e) => !e.expiresAt || new Date(e.expiresAt) > now)
        .map((e) => e.ip as string)
    );

    regionBlock = new Set((rbEntries as any[]).map((e) => e.countryCode as string));
  } catch (err) {
    // No crashear si la DB no está disponible al inicio
    strapi.log.warn(`[ip-security] No se pudo refrescar cache: ${err}`);
  }
};

// ─── Auto-bloqueo ─────────────────────────────────────────────────────────────

const autoBlock = async (strapi: Core.Strapi, ip: string, reason: string): Promise<void> => {
  if (blacklist.has(ip)) return; // ya bloqueada
  blacklist.add(ip);
  strapi.log.warn(`[ip-security] Auto-bloqueo: ${ip} | Razón: ${reason}`);
  try {
    await strapi.entityService.create('api::ip-blacklist.ip-blacklist', {
      data: {
        ip,
        reason,
        autoBlocked: true,
        blockedAt: new Date().toISOString(),
        active: true,
      },
    });
  } catch (err) {
    strapi.log.error(`[ip-security] No se pudo persistir auto-bloqueo de ${ip}: ${err}`);
  }
};

// ─── Middleware principal ─────────────────────────────────────────────────────

export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const path: string = ctx.request.path ?? '';

    // Solo aplica a rutas /api — todo lo demás (admin, plugins, uploads, etc.) pasa libre
    if (!path.startsWith('/api')) {
      return next();
    }

    const ip = getClientIp(ctx);

    // Refrescar cache (máximo una vez cada 60s)
    await refreshCache(strapi);

    // 1. Whitelist → siempre permitida, sin más verificaciones
    if (whitelist.has(ip)) {
      return next();
    }

    // 2. Blacklist → bloqueada
    if (blacklist.has(ip)) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden', message: 'Acceso denegado.' };
      return;
    }

    // 3. Detección de patrones de ataque en la URL/query
    const matchedPattern = hasAttackPattern(ctx);
    if (matchedPattern) {
      await autoBlock(strapi, ip, `Patrón de ataque detectado en: ${ctx.request.path}`);
      ctx.status = 403;
      ctx.body = { error: 'Forbidden', message: 'Solicitud bloqueada por seguridad.' };
      return;
    }

    // 4. Rate limiting
    const requestCount = incrementCounter(rateLimitMap, ip, RATE_WINDOW_MS);
    if (requestCount > RATE_MAX_REQUESTS) {
      await autoBlock(
        strapi,
        ip,
        `Rate limit excedido: ${requestCount} solicitudes en 60s (máx ${RATE_MAX_REQUESTS})`
      );
      ctx.status = 429;
      ctx.body = { error: 'Too Many Requests', message: 'Demasiadas solicitudes. IP bloqueada.' };
      return;
    }

    // 5. Bloqueo por región (geolocalización)
    if (regionBlock.size > 0) {
      const geo = geoip.lookup(ip);
      if (geo && regionBlock.has(geo.country)) {
        ctx.status = 403;
        ctx.body = {
          error: 'Forbidden',
          message: `Acceso denegado desde tu región (${geo.country}).`,
        };
        return;
      }
    }

    // Continuar con la solicitud
    await next();

    // 6. Post-request: rastrear 404 excesivos (escáneres de rutas)
    if (ctx.status === 404) {
      const notFoundCount = incrementCounter(notFoundMap, ip, RATE_WINDOW_MS);
      if (notFoundCount > NOT_FOUND_MAX) {
        await autoBlock(
          strapi,
          ip,
          `Escaneo de rutas detectado: ${notFoundCount} errores 404 en 60s (máx ${NOT_FOUND_MAX})`
        );
      }
    }
  };
};
