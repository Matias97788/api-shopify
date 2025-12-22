import axios from 'axios';
import logger from './logger.js';

// Interceptores para logging de llamadas a Shopify (sin token)
axios.interceptors.request.use((config) => {
  config.metadata = { startTime: Date.now() };
  const method = (config.method || 'GET').toUpperCase();
  const url = config.url;
  const hasBody = !!config.data;
  try {
    logger.debug(`[Shopify] --> ${method} ${url}`);
    if (hasBody) {
      const keys = typeof config.data === 'object' ? Object.keys(config.data) : ['<raw>'];
      logger.debug(`[Shopify]     payload keys: ${keys.join(', ')}`);
    }
  } catch {}
  return config;
});

axios.interceptors.response.use(
  (response) => {
    const method = (response.config?.method || 'GET').toUpperCase();
    const url = response.config?.url;
    const ms = response.config?.metadata?.startTime ? (Date.now() - response.config.metadata.startTime) : undefined;
    try {
      logger.info(`[Shopify] <-- ${method} ${url} | ${response.status}${ms !== undefined ? ` in ${ms}ms` : ''}`);
    } catch {}
    return response;
  },
  (error) => {
    const cfg = error.config || {};
    const method = (cfg.method || 'GET').toUpperCase();
    const url = cfg.url;
    const status = error.response?.status;
    const ms = cfg.metadata?.startTime ? (Date.now() - cfg.metadata.startTime) : undefined;
    const msg = error.response?.data?.errors || error.message;
    try {
      logger.error(`[Shopify] !!  ${method} ${url} | ${status ?? 'ERR'}${ms !== undefined ? ` in ${ms}ms` : ''} | ${msg}`);
    } catch {}
    return Promise.reject(error);
  }
);

const API_VERSION = '2024-10';

function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno: ${name}`);
  return v;
}

export async function obtenerProductos({ limit = 50, page_info } = {}) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (page_info) params.set('page_info', String(page_info));
  const url = `https://${domain}/admin/api/${API_VERSION}/products.json?${params.toString()}`;
  const resp = await axios.get(url, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  const products = (resp.data?.products || []).map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: p.tags,
    created_at: p.created_at,
    updated_at: p.updated_at,
    images: (p.images || []).map(img => ({ id: img.id, src: img.src, alt: img.alt })),
    variants: (p.variants || []).map(v => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
      compare_at_price: v.compare_at_price,
      inventory_quantity: v.inventory_quantity,
      inventory_policy: v.inventory_policy,
      inventory_item_id: v.inventory_item_id
    }))
  }));

  // Parse Link header for pagination: extract next page_info if available
  const linkHeader = resp.headers?.link || resp.headers?.Link;
  let next_page_info;
  if (linkHeader) {
    // Look for rel="next" and capture page_info
    const match = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/i);
    if (match && match[1]) {
      next_page_info = match[1];
    }
  }

  return { products, raw: resp.data, next_page_info };
}

// Obtiene datos de una variante por ID (incluye inventory_item_id y inventory_quantity)
export async function obtenerVariante(variantId) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');

  const url = `https://${domain}/admin/api/${API_VERSION}/variants/${variantId}.json`;
  const resp = await axios.get(url, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  const v = resp.data?.variant;
  if (!v) throw new Error('Variante no encontrada');
  return {
    id: v.id,
    inventory_item_id: v.inventory_item_id,
    inventory_quantity: v.inventory_quantity
  };
}

// Cron programado: consulta una fuente externa y actualiza stock si cambió
export async function sincronizarStockProgramado() {
  const externalUrl = process.env.EXTERNAL_STOCK_URL;
  if (!externalUrl) {
    return { ok: true, message: 'EXTERNAL_STOCK_URL no configurado; no se realizaron actualizaciones', updates_applied: 0 };
  }

  // Obtener datos externos: soporta formato { updates: [...] } o array directo
  const extResp = await axios.get(externalUrl, { headers: { 'Accept': 'application/json' } });
  let externalItems = extResp.data?.updates || extResp.data;
  if (!Array.isArray(externalItems)) {
    return { ok: false, error: 'Formato externo inválido: se esperaba array o { updates: [...] }' };
  }

  const updates = [];
  for (const item of externalItems) {
    const { variant_id, available } = item || {};
    if (!variant_id || available === undefined || available === null) continue;

    // Consultar el estado actual en Shopify para comparar
    try {
      const variante = await obtenerVariante(variant_id);
      const current = variante.inventory_quantity;
      if (Number(current) !== Number(available)) {
        updates.push({ variant_id, available });
      }
    } catch (e) {
      // Si falla la consulta de variante, ignoramos ese item
    }
  }

  if (updates.length === 0) {
    return { ok: true, message: 'Sin cambios de stock detectados', updates_applied: 0 };
  }

  const result = await actualizarStock(updates);
  return { ok: true, message: 'Stock sincronizado', updates_applied: result.count, details: result.results };
}
// Obtiene el inventory_item_id de un variant_id
export async function obtenerInventoryItemIdDeVariante(variantId) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');

  const url = `https://${domain}/admin/api/${API_VERSION}/variants/${variantId}.json`;
  const resp = await axios.get(url, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  const variant = resp.data?.variant;
  if (!variant?.inventory_item_id) {
    throw new Error('No se encontró inventory_item_id para el variant');
  }
  return variant.inventory_item_id;
}

// Setea el stock (available) de un inventory_item_id en una o varias locations (separadas por coma)
export async function establecerNivelInventario({ inventory_item_id, available }) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');
  const locationEnv = getEnv('SHOPIFY_LOCATION_ID');

  // Soporte para múltiples locations separadas por coma
  const locationIds = locationEnv.split(',').map(s => s.trim()).filter(Boolean);

  if (locationIds.length === 0) {
    throw new Error('SHOPIFY_LOCATION_ID no contiene ningún ID válido');
  }

  const results = [];
  const errors = [];

  for (const location_id of locationIds) {
    const url = `https://${domain}/admin/api/${API_VERSION}/inventory_levels/set.json`;
    const payload = { inventory_item_id, location_id, available };
    
    try {
      const resp = await axios.post(url, payload, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });
      results.push({ location_id, data: resp.data });
    } catch (err) {
      // Si falla una location, registramos el error pero intentamos las otras
      const msg = err.response?.data?.errors || err.message;
      logger.error(`[Shopify] Error updating location ${location_id}: ${msg}`);
      errors.push({ location_id, error: msg });
    }
  }

  // Si fallaron todas, lanzamos error
  if (results.length === 0 && errors.length > 0) {
    throw new Error(`Fallo al actualizar stock en todas las locations: ${errors.map(e => e.location_id).join(', ')}`);
  }

  return { updated: results, errors };
}

// Actualiza stock para uno o varios items: { inventory_item_id | variant_id, available }
export async function actualizarStock(updates) {
  const items = Array.isArray(updates) ? updates : [updates];

  const results = [];
  for (const item of items) {
    const { available } = item;
    if (available === undefined || available === null) {
      throw new Error('Cada item debe incluir "available"');
    }

    let inventory_item_id = item.inventory_item_id;
    if (!inventory_item_id && item.variant_id) {
      inventory_item_id = await obtenerInventoryItemIdDeVariante(item.variant_id);
    }

    if (!inventory_item_id) {
      throw new Error('Se requiere inventory_item_id o variant_id por item');
    }

    const data = await establecerNivelInventario({ inventory_item_id, available });
    results.push({ ok: true, inventory_item_id, available, data });
  }

  return { ok: true, count: results.length, results };
}

// Actualiza el precio de una variante por variant_id
export async function actualizarPrecioVariante({ variant_id, price, compare_at_price }) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');

  if (!variant_id) {
    throw new Error('Se requiere variant_id');
  }
  if (price === undefined || price === null) {
    throw new Error('Se requiere "price"');
  }

  const url = `https://${domain}/admin/api/${API_VERSION}/variants/${variant_id}.json`;

  const variantPayload = { id: variant_id, price: String(price) };
  if (compare_at_price !== undefined && compare_at_price !== null) {
    variantPayload.compare_at_price = String(compare_at_price);
  }

  const payload = { variant: variantPayload };

  const resp = await axios.put(url, payload, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  return resp.data;
}

// Actualiza precios para uno o varios items: { variant_id, price, compare_at_price? }
export async function actualizarPrecios(updates) {
  const items = Array.isArray(updates) ? updates : [updates];

  const results = [];
  for (const item of items) {
    const { variant_id, price, compare_at_price } = item;
    if (!variant_id) {
      throw new Error('Cada item debe incluir "variant_id"');
    }
    if (price === undefined || price === null) {
      throw new Error('Cada item debe incluir "price"');
    }

    const data = await actualizarPrecioVariante({ variant_id, price, compare_at_price });
    results.push({ ok: true, variant_id, price: String(price), compare_at_price: compare_at_price !== undefined ? String(compare_at_price) : undefined, data });
  }

  return { ok: true, count: results.length, results };
}
