import axios from 'axios';

const API_VERSION = '2024-10';

function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno: ${name}`);
  return v;
}

export async function obtenerProductos() {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');

  const url = `https://${domain}/admin/api/${API_VERSION}/products.json?limit=50`;
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

  return { products, raw: resp.data };
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

// Setea el stock (available) de un inventory_item_id en una location
export async function establecerNivelInventario({ inventory_item_id, available }) {
  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const token = getEnv('SHOPIFY_ADMIN_TOKEN');
  const location_id = getEnv('SHOPIFY_LOCATION_ID');

  const url = `https://${domain}/admin/api/${API_VERSION}/inventory_levels/set.json`;
  const payload = { inventory_item_id, location_id, available };
  const resp = await axios.post(url, payload, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  return resp.data;
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