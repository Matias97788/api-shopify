import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import crypto from 'crypto';
import axios from 'axios';
import cron from 'node-cron';
import logger from './logger.js';
import { obtenerProductos, actualizarStock, actualizarPrecios, sincronizarStockProgramado } from './shopify.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
// Logging HTTP
app.use(morgan('combined'));
// Genera/propaga un request-id para trazabilidad
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  res.setHeader('x-request-id', req.requestId);
  next();
});
// Logging HTTP con niveles y request-id
app.use((req, _res, next) => {
  const meta = { id: req.requestId };
  if (req.method === 'GET') {
    logger.info(`[HTTP] ${req.method} ${req.path}`, { ...meta, query: req.query });
  } else {
    logger.info(`[HTTP] ${req.method} ${req.path}`, { ...meta, body: req.body });
  }
  next();
});

// --- Cron Jobs infra ---
const jobs = new Map(); // jobName -> { config, task }
const runsHistory = []; // [{ id, job, status, startedAt, finishedAt, message }]

async function runJob(jobName) {
  const start = new Date();
  const run = {
    id: `${Date.now()}`,
    job: jobName,
    status: 'running',
    startedAt: start.toISOString(),
    finishedAt: '',
    message: ''
  };
  runsHistory.unshift(run);
  try {
    if (jobName === 'syncProducts') {
      const { products, next_page_info } = await obtenerProductos({ limit: 50 });
      run.status = 'success';
      run.message = `Obtenidos ${products.length} productos. next_page_info=${next_page_info ?? 'none'}`;
    } else if (jobName === 'syncStock') {
      const result = await sincronizarStockProgramado();
      run.status = 'success';
      run.message = `Actualización de stock aplicada: ${result.updates_applied ?? 0}`;
    } else {
      throw new Error(`Job no soportado: ${jobName}`);
    }
  } catch (e) {
    run.status = 'error';
    run.message = e?.message || 'Error';
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

function upsertCronJob({ jobName, expression, enabled, timezone = 'America/Santiago' }) {
  if (!jobName || !expression) throw new Error('Faltan campos: jobName y expression son obligatorios');
  if (!cron.validate(expression)) throw new Error('Expresión CRON inválida');

  const current = jobs.get(jobName);
  if (current?.task) {
    try { current.task.stop(); } catch {}
  }

  let task = null;
  if (enabled) {
    task = cron.schedule(expression, () => runJob(jobName), { timezone });
    task.start();
  }

  const config = { jobName, expression, enabled: !!enabled, timezone, updatedAt: new Date().toISOString() };
  jobs.set(jobName, { config, task });
  return config;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/products', async (req, res) => {
  try {
    const { limit, page_info } = req.query || {};
    const parsedLimit = limit ? Number(limit) : undefined;
    const { products, next_page_info } = await obtenerProductos({ limit: parsedLimit, page_info });
    logger.info('[HTTP] /products success', { id: req.requestId, count: products.length, next_page_info });
    res.json({ count: products.length, next_page_info, products });
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    logger.error('[HTTP] /products error', { id: req.requestId, status, msg });
    res.status(status).json({ error: 'No se pudieron obtener los productos', details: msg });
  }
});

const BODEGA_NAMES = {
      10: 'Flotaservicio Los Ángeles',
      14: 'Serviteca Los Ángeles',
      20: 'Talca',
      24: 'Curicó',
      30: 'Chillán',
      40: 'Concepción - Talcahuano',
      50: 'Temuco',
      55: 'Valdivia',
      60: 'Osorno',
      70: 'Santiago',
      75: 'Vitacura'
    };

    // Consulta /products para obtener un SKU y luego consulta API externa con ese SKU
    app.get('/obtenerporductosbasecruz', async (req, res) => {
  try {
    // Usa el cliente directo a Shopify para obtener productos con paginación
    const { limit, page_info } = req.query || {};
    const parsedLimit = limit ? Number(limit) : undefined;
    const { products, next_page_info } = await obtenerProductos({ limit: parsedLimit, page_info });

    // Extrae entries SKU con contexto de nombre y stock en Shopify
    const skuEntries = [];
    for (const p of products) {
      const productName = p.title;
      const variants = p.variants || [];
      for (const v of variants) {
        const sku = (v?.sku || '').trim();
        if (!sku) continue;
        skuEntries.push({ 
          sku, 
          product_name: productName, 
          shopify_stock: v.inventory_quantity ?? null,
          shopify_bodegas: v.inventory_levels || []
        });
      }
    }

    if (skuEntries.length === 0) {
      return res.json({ success: true, next_page_info, data: [] });
    }

    const apiKey = process.env.EXTERNAL_API_KEY || 'e6c121ec6fe849dc2686b00d8f132a92873ac9d572e20f208190b6232d976c6';
    const externalUrl = process.env.EXTERNAL_STOCK_URL || 'http://192.168.3.172:3000/api/query';

    // Función para consultar API externa por SKU
    const queryExternal = async (sku) => {
      const payload = { queryName: 'stockPorProducto', params: [sku] };
      const resp = await axios.post(externalUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }
      });
      return resp.data?.data || [];
    };

    // Ejecuta con concurrencia limitada para evitar saturar la API externa
    const concurrency = 5;
    const results = [];
    let index = 0;
    async function runBatch() {
      const batch = skuEntries.slice(index, index + concurrency);
      index += concurrency;
      await Promise.all(batch.map(async ({ sku, product_name, shopify_stock, shopify_bodegas }) => {
        try {
          const extData = await queryExternal(sku);
          const rows = Array.isArray(extData) ? extData : [];
          const augmented = rows
            .filter(row => row?.bodega != 18)
            .map(row => ({
            bodega: row?.bodega ?? null,
            nombre_bodega: BODEGA_NAMES[row?.bodega] || null,
            producto: sku,
            stock_real: Number(row?.stock_real ?? 0),
            product_name,
            shopify_stock,
            shopify_bodegas
          }));
          if (augmented.length === 0) {
            // Asegura que se muestre la bodega (null) y stock_real 0
            results.push({
              bodega: null,
              producto: sku,
              stock_real: 0,
              product_name,
              shopify_stock,
              shopify_bodegas
            });
          } else {
            results.push(...augmented);
          }
        } catch (e) {
          logger.error('[HTTP] /obtenerporductosbasecruz external error', { id: req.requestId, sku, msg: e?.message });
          // En caso de error externo, mostramos el producto con stock externo 0/null para que no desaparezca de la lista
          results.push({
            bodega: 'ERROR_EXTERNO',
            producto: sku,
            stock_real: 0,
            product_name,
            shopify_stock,
            shopify_bodegas
          });
        }
      }));
    }

    while (index < skuEntries.length) {
      // eslint-disable-next-line no-await-in-loop
      await runBatch();
    }

    const group = (req.query?.group || '').toString().toLowerCase();

    if (group === 'sku') {
      const groupedMap = new Map();
      for (const row of results) {
        const sku = row.producto;
        if (!groupedMap.has(sku)) {
          groupedMap.set(sku, {
            sku,
            product_name: row.product_name,
            shopify_stock: row.shopify_stock,
            shopify_bodegas: row.shopify_bodegas || [],
            _bodegas: new Map()
          });
        }
        const entry = groupedMap.get(sku);
        const bKey = row.bodega === undefined ? null : row.bodega;
        entry._bodegas.set(bKey, Number(row.stock_real ?? 0));
      }
      const grouped = Array.from(groupedMap.values()).map(e => ({
        sku: e.sku,
        product_name: e.product_name,
        shopify_stock: e.shopify_stock,
        shopify_bodegas: e.shopify_bodegas,
        bodegas: Array.from(e._bodegas.entries()).map(([bodega, stock_real]) => ({
          bodega,
          nombre_bodega: BODEGA_NAMES[bodega] || null,
          stock_real
        }))
      }));
      logger.info('[HTTP] /obtenerporductosbasecruz success (group=sku)', { id: req.requestId, skus_count: skuEntries.length, groups: grouped.length, next_page_info });
      return res.json({ success: true, next_page_info, data: grouped });
    }

    logger.info('[HTTP] /obtenerporductosbasecruz success', { id: req.requestId, skus_count: skuEntries.length, rows: results.length, next_page_info });
    res.json({ success: true, next_page_info, data: results });
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error || err?.response?.data || err.message;
    logger.error('[HTTP] /obtenerporductosbasecruz error', { id: req.requestId, status, msg });
    res.status(status).json({ error: 'No se pudo obtener datos externos', details: msg });
  }
});

// Actualiza stock (available) de uno o varios items
app.post('/stock', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = body.updates ?? body;

    if (!updates || (Array.isArray(updates) && updates.length === 0)) {
      return res.status(400).json({ error: 'Falta body con updates o un objeto de actualización' });
    }

    const result = await actualizarStock(updates);
    logger.info('[HTTP] /stock success', { id: req.requestId, count: result.count });
    res.json(result);
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    logger.error('[HTTP] /stock error', { id: req.requestId, status, msg });
    res.status(status).json({ error: 'No se pudo actualizar el stock', details: msg });
  }
});

// Actualiza precios (price y opcional compare_at_price) de uno o varios variants
app.post('/prices', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = body.updates ?? body;

    if (!updates || (Array.isArray(updates) && updates.length === 0)) {
      return res.status(400).json({ error: 'Falta body con updates o un objeto de actualización' });
    }

    const result = await actualizarPrecios(updates);
    logger.info('[HTTP] /prices success', { id: req.requestId, count: result.count });
    res.json(result);
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    logger.error('[HTTP] /prices error', { id: req.requestId, status, msg });
    res.status(status).json({ error: 'No se pudieron actualizar los precios', details: msg });
  }
});

// Cron: consulta fuente externa y actualiza stock si hay cambios
app.get('/cron/stock-sync', async (req, res) => {
  try {
    const result = await sincronizarStockProgramado();
    logger.info('[HTTP] /cron/stock-sync success', { id: req.requestId, updates_applied: result.updates_applied });
    res.json(result);
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    logger.error('[HTTP] /cron/stock-sync error', { id: req.requestId, status, msg });
    res.status(status).json({ error: 'Fallo sincronización de stock', details: msg });
  }
});

// --- Endpoints de administración de cron ---
app.post('/cron/jobs', (req, res) => {
  try {
    const config = upsertCronJob(req.body || {});
    res.json({ ok: true, config });
  } catch (e) {
    res.status(400).json({ ok: false, message: e?.message || 'Error' });
  }
});

app.post('/cron/jobs/:jobName/run', async (req, res) => {
  const { jobName } = req.params;
  if (!jobs.has(jobName)) return res.status(404).json({ ok: false, message: 'Job no configurado' });
  await runJob(jobName);
  res.json({ ok: true });
});

app.get('/cron/jobs', (_req, res) => {
  const list = [...jobs.values()].map(({ config }) => config);
  res.json({ ok: true, jobs: list, runs: runsHistory.slice(0, 100) });
});

app.get('/cron/jobs/:jobName', (req, res) => {
  const { jobName } = req.params;
  const entry = jobs.get(jobName);
  if (!entry) return res.status(404).json({ ok: false, message: 'Job no configurado' });
  res.json({ ok: true, config: entry.config });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`API corriendo en http://localhost:${port}`);
});
