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
let locationsCache = null; // Map<location_id, location_name>

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

  // Enriquecer con niveles de inventario por location
  try {
    if (products.length > 0 && products[0].variants.length > 0) {
      logger.debug(`[Shopify] First variant debug: ${JSON.stringify(products[0].variants[0])}`);
    }

    const inventoryItemIds = products
      .flatMap(p => p.variants)
      .map(v => v.inventory_item_id)
      .filter(Boolean);

    if (inventoryItemIds.length > 0) {
       logger.debug(`[Shopify] Fetching inventory for ${inventoryItemIds.length} items`);
       
       // Obtener mapa de ubicaciones para enriquecer con nombres
       const locationsMap = await obtenerMapaUbicaciones();
       
       const levelsMap = await obtenerNivelesInventario(inventoryItemIds);
       logger.debug(`[Shopify] Fetched levels for ${levelsMap.size} items`);
       
       // Asignar niveles a cada variante
       for (const p of products) {
         for (const v of p.variants) {
            const hasIt = levelsMap.has(v.inventory_item_id);
            if (v.inventory_item_id && hasIt) {
             const rawLevels = levelsMap.get(v.inventory_item_id);
             v.inventory_levels = rawLevels.map(lvl => ({
               ...lvl,
               location_name: locationsMap.get(lvl.location_id) || `Location ${lvl.location_id}`
             }));
           } else {
             v.inventory_levels = [];
           }
         }
       }
    }
  } catch (err) {
    logger.error(`[Shopify] Error fetching inventory levels: ${err.message}`);
    // No fallamos todo el request, solo logueamos y seguimos sin el detalle
  }

  return { products, raw: resp.data, next_page_info };
}

// Obtiene niveles de inventario para una lista de inventory_item_ids
async function obtenerNivelesInventario(inventoryItemIds) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');
  
  // Shopify permite filtrar por inventory_item_ids (lista separada por comas)
  // Se recomienda hacer batches si son muchos. El límite suele ser 50 IDs por request.
  const uniqueIds = [...new Set(inventoryItemIds)];
  const chunkSize = 50;
  const chunks = [];
  
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    chunks.push(uniqueIds.slice(i, i + chunkSize));
  }

  const levelsMap = new Map(); // inventory_item_id -> array of levels

  for (const chunk of chunks) {
    const idsParam = chunk.join(',');
    let nextUrl = `https://${domain}/admin/api/${API_VERSION}/inventory_levels.json?inventory_item_ids=${idsParam}&limit=250`;
    
    while (nextUrl) {
        try {
          const resp = await axios.get(nextUrl, {
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          });
          
          const levels = resp.data?.inventory_levels || [];
          for (const level of levels) {
            const itemId = level.inventory_item_id;
            if (!levelsMap.has(itemId)) {
              levelsMap.set(itemId, []);
            }
            levelsMap.get(itemId).push({
              location_id: level.location_id,
              available: level.available
            });
          }

          // Handle pagination
          const linkHeader = resp.headers?.link || resp.headers?.Link;
          let foundNext = false;
          if (linkHeader) {
            const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
            if (match && match[1]) {
              nextUrl = match[1];
              foundNext = true;
            }
          }
          
          if (!foundNext) {
            nextUrl = null;
          }

        } catch (e) {
          logger.error(`[Shopify] Error fetching inventory chunk: ${e.message}`);
          nextUrl = null; // Stop this chunk on error
        }
    }
  }
  
  return levelsMap;
}

// Obtiene lista de ubicaciones y cachea el resultado
async function obtenerMapaUbicaciones() {
  if (locationsCache) return locationsCache;

  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');
  const url = `https://${domain}/admin/api/${API_VERSION}/locations.json`;

  try {
    const resp = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    const locations = resp.data?.locations || [];
    const map = new Map();
    for (const loc of locations) {
      map.set(loc.id, loc.name);
    }
    locationsCache = map;
    logger.info(`[Shopify] Ubicaciones cargadas: ${map.size}`);
    return map;
  } catch (e) {
    logger.error(`[Shopify] Error fetching locations: ${e.message}`);
    return new Map();
  }
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
export async function establecerNivelInventario({ inventory_item_id, available, location_id: specificLocationId }) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');
  
  let locationIds = [];

  if (specificLocationId) {
    locationIds = [specificLocationId];
  } else {
    const locationEnv = getEnv('SHOPIFY_LOCATION_ID');
    // Soporte para múltiples locations separadas por coma
    locationIds = locationEnv.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (locationIds.length === 0) {
    throw new Error('No se especificó location_id y SHOPIFY_LOCATION_ID no contiene ningún ID válido');
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

// Actualiza stock para uno o varios items: { inventory_item_id | variant_id, available, location_id?, location_name? }
export async function actualizarStock(updates) {
  const items = Array.isArray(updates) ? updates : [updates];

  const results = [];
  // Use sequential processing to be safe with rate limits, or batch with limit.
  // Given user request "batch processing", sequential is fine but let's robustify.
  for (const item of items) {
    const { available } = item;
    if (available === undefined || available === null) {
       results.push({ ok: false, error: 'Cada item debe incluir "available"', item });
       continue;
    }

    let inventory_item_id = item.inventory_item_id;

    // Resolve ID if missing
    if (!inventory_item_id) {
        try {
            if (item.variant_id) {
                inventory_item_id = await obtenerInventoryItemIdDeVariante(item.variant_id);
            } else if (item.sku) {
                inventory_item_id = await obtenerInventoryItemIdPorSku(item.sku);
            }
        } catch (e) {
            results.push({ ok: false, error: e.message, item });
            continue;
        }
    }

    if (!inventory_item_id) {
       results.push({ ok: false, error: 'Could not resolve inventory_item_id from variant_id or sku', item });
       continue;
    }

    // Resolver location
    let targetLocationId = item.location_id;
    if (!targetLocationId && item.location_name) {
        const map = await obtenerMapaUbicaciones();
        // Buscar location_id por nombre (case insensitive)
        const normalizedName = item.location_name.toLowerCase().trim();
        for (const [id, name] of map.entries()) {
           if (name.toLowerCase().trim() === normalizedName) {
             targetLocationId = id;
             break;
           }
        }
        if (!targetLocationId) {
             results.push({ ok: false, error: `Location '${item.location_name}' not found` });
             continue;
        }
    }

    if (!targetLocationId) {
        results.push({ ok: false, error: 'Missing location_id or valid location_name' });
        continue;
    }

    try {
      const data = await establecerNivelInventario({ inventory_item_id, available, location_id: targetLocationId });
      results.push({ ok: true, inventory_item_id, available, location_id: targetLocationId, data });
    } catch (e) {
      results.push({ ok: false, error: e.message, inventory_item_id });
    }
  }

  return { ok: true, count: results.length, results };
}

// Resuelve SKU a InventoryItemId usando GraphQL
async function obtenerInventoryItemIdPorSku(sku) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');

  const query = `
    query($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            inventoryItem {
              id
            }
          }
        }
      }
    }
  `;

  try {
    const resp = await axios.post(
      `https://${domain}/admin/api/${API_VERSION}/graphql.json`,
      {
        query,
        variables: { query: `sku:${sku}` }
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    const edges = resp.data?.data?.productVariants?.edges;
    if (edges && edges.length > 0) {
      const gid = edges[0].node.inventoryItem.id; // gid://shopify/InventoryItem/123456
      return gid.split('/').pop();
    }
    return null;
  } catch (e) {
    logger.error(`[Shopify] Error resolving SKU ${sku}: ${e.message}`);
    return null;
  }
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
