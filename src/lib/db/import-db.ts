import { createClient, SupabaseClient } from '@supabase/supabase-js';

import { computeRating } from '@/lib/rating/engine';

import { hasTable } from '@/lib/db-features';

import { sarToUsd } from '@/lib/pricing';

import { normalizeCjVideoUrl } from '@/lib/cj/video';

import { normalizeCjImageKey } from '@/lib/cj/image-gallery';

import { normalizeSizeList } from '@/lib/cj/size-normalization';

import { enhanceProductImageUrl } from '@/lib/media/image-quality';



let supabaseAdmin: SupabaseClient | null = null;



function getSupabaseAdmin(): SupabaseClient | null {

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {

    console.error('[Import DB] Missing Supabase credentials:', { url: !!url, key: !!key });

    return null;

  }

  if (!supabaseAdmin) {

    supabaseAdmin = createClient(url, key);

  }

  return supabaseAdmin;

}



export function isImportDbConfigured(): boolean {

  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

}



function buildSchemaErrorText(error: any): string {

  return `${String(error?.message || '')} ${String(error?.details || '')} ${String(error?.hint || '')}`.toLowerCase();

}



function isSchemaMissingColumnError(error: any, columnName?: string): boolean {

  if (!error) return false;

  const code = String(error?.code || '').toUpperCase();

  const text = buildSchemaErrorText(error);



  const isMissingColumn =

    code === 'PGRST204' ||

    code === '42703' ||

    /could not find the ['"`][a-z0-9_]+['"`] column/i.test(text) ||

    /column ['"`]?[a-z0-9_.]+['"`]? does not exist/i.test(text) ||

    /column ['"`]?[a-z0-9_]+['"`]? of relation ['"`]?[a-z0-9_]+['"`]? does not exist/i.test(text);



  if (!columnName) return isMissingColumn;



  const normalizedColumn = String(columnName).trim().toLowerCase();

  if (!normalizedColumn) return isMissingColumn;

  const mentionsColumn = text.includes(normalizedColumn);



  return isMissingColumn && mentionsColumn;

}



function normalizeQueueRatingValue(value: unknown): number | null {

  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) return null;

  return Math.max(0, Math.min(5, n));

}

const IMPORT_QUEUE_PLACEHOLDER_CATEGORY_TOKENS = new Set([
  'general',
  'uncategorized',
  'unknown',
  'misc',
  'others',
]);
const IMPORT_QUEUE_INGESTION_BLOCK_PREFIX = 'INGESTION_FIDELITY_BLOCKED';

function isPlaceholderQueueNameForInsert(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (/^cj product\b/.test(normalized)) return true;
  if (/^unavailable cj product\b/.test(normalized)) return true;
  if (/^unknown product\b/.test(normalized)) return true;
  return false;
}

function isPlaceholderQueueCategoryForInsert(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return IMPORT_QUEUE_PLACEHOLDER_CATEGORY_TOKENS.has(normalized);
}

function hasMeaningfulQueueInsertVariantData(variants: any[]): boolean {
  return variants.some((variant: any) => {
    if (!variant || typeof variant !== 'object') return false;
    const variantSku = typeof variant?.variantSku === 'string' ? variant.variantSku.trim() : '';
    if (!variantSku) return false;

    const sellPriceSar = Number(
      variant?.sellPriceSAR ??
      variant?.price ??
      variant?.sellPriceSar
    );
    if (!Number.isFinite(sellPriceSar) || sellPriceSar <= 0) return false;

    const stock = Number(
      variant?.stock ??
      variant?.totalStock ??
      (Number(variant?.cjStock || 0) + Number(variant?.factoryStock || 0))
    );
    const hasStock = Number.isFinite(stock) && stock > 0;
    const hasDimensions = typeof variant?.color === 'string' || typeof variant?.size === 'string';
    return hasStock || hasDimensions;
  });
}

function parseQueueJsonArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseQueueJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isQueueRowHighFidelityForDowngradeGuard(row: any): boolean {
  if (!row || typeof row !== 'object') return false;

  const rowName = typeof row?.name_en === 'string' ? row.name_en.trim() : '';
  const rowCategory = (
    (typeof row?.category_name === 'string' && row.category_name.trim()) ||
    (typeof row?.category === 'string' && row.category.trim()) ||
    ''
  );

  const rowImagesRaw = parseQueueJsonArray(row?.images);
  const rowImages = rowImagesRaw.filter((imageUrl) => typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl.trim()));
  const rowColorImageMap = parseQueueJsonObject(row?.color_image_map);
  const rowVariants = parseQueueJsonArray(row?.variants);

  const hasRealName = !isPlaceholderQueueNameForInsert(rowName);
  const hasRealCategory = !isPlaceholderQueueCategoryForInsert(rowCategory);
  const hasRealGallery = rowImages.length > 0 || Boolean(rowColorImageMap && Object.keys(rowColorImageMap).length > 0);
  const hasRealVariants = hasMeaningfulQueueInsertVariantData(rowVariants);
  return hasRealName && hasRealCategory && hasRealGallery && hasRealVariants;
}

function extractMissingColumnNames(error: any): string[] {

  const text = `${String(error?.message || '')}\n${String(error?.details || '')}\n${String(error?.hint || '')}`.toLowerCase();

  const found = new Set<string>();



  const captureMatches = (pattern: RegExp) => {

    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {

      const raw = String(match[1] || '').trim().replace(/["'`]/g, '');

      if (!raw) continue;

      const normalized = raw.includes('.') ? (raw.split('.').pop() || '') : raw;

      if (/^[a-z0-9_]+$/.test(normalized)) {

        found.add(normalized);

      }

    }

  };



  captureMatches(/could not find the ['"`]([a-z0-9_]+)['"`] column/gi);

  captureMatches(/column ['"`]?([a-z0-9_.]+)['"`]? does not exist/gi);

  captureMatches(/column ['"`]?([a-z0-9_]+)['"`]? of relation ['"`]?[a-z0-9_]+['"`]? does not exist/gi);



  return Array.from(found);

}



// Check if all required columns exist in product_queue table

// This covers ALL columns that addProductToQueue writes to

export async function checkProductQueueSchema(): Promise<{

  ready: boolean;

  missingColumns: string[];

  migrationSQL: string;

}> {

  const supabase = getSupabaseAdmin();

  if (!supabase) {

    return { ready: false, missingColumns: ['(supabase not configured)'], migrationSQL: '' };

  }



  // ALL extended columns that addProductToQueue requires

  const requiredColumns = [

    { name: 'video_url', type: 'TEXT', default: 'NULL' },

    { name: 'video_source_url', type: 'TEXT', default: 'NULL' },

    { name: 'video_4k_url', type: 'TEXT', default: 'NULL' },

    { name: 'video_delivery_mode', type: 'TEXT', default: 'NULL' },

    { name: 'video_quality_gate_passed', type: 'BOOLEAN', default: 'NULL' },

    { name: 'video_source_quality_hint', type: 'TEXT', default: 'NULL' },

    { name: 'media_mode', type: 'TEXT', default: 'NULL' },

    { name: 'has_video', type: 'BOOLEAN', default: 'false' },

    { name: 'product_code', type: 'TEXT', default: 'NULL' },

    { name: 'weight_g', type: 'NUMERIC', default: 'NULL' },

    { name: 'pack_length', type: 'NUMERIC', default: 'NULL' },

    { name: 'pack_width', type: 'NUMERIC', default: 'NULL' },

    { name: 'pack_height', type: 'NUMERIC', default: 'NULL' },

    { name: 'material', type: 'TEXT', default: 'NULL' },

    { name: 'origin_country', type: 'TEXT', default: 'NULL' },

    { name: 'hs_code', type: 'TEXT', default: 'NULL' },

    { name: 'category_name', type: 'TEXT', default: 'NULL' },

    { name: 'store_sku', type: 'TEXT', default: 'NULL' },

    { name: 'overview', type: 'TEXT', default: 'NULL' },

    { name: 'product_info', type: 'TEXT', default: 'NULL' },

    { name: 'size_info', type: 'TEXT', default: 'NULL' },

    { name: 'product_note', type: 'TEXT', default: 'NULL' },

    { name: 'packing_list', type: 'TEXT', default: 'NULL' },

    { name: 'available_colors', type: 'JSONB', default: 'NULL' },

    { name: 'available_sizes', type: 'JSONB', default: 'NULL' },

    { name: 'available_models', type: 'JSONB', default: 'NULL' },

    { name: 'size_chart_images', type: 'JSONB', default: 'NULL' },

    { name: 'cj_category_id', type: 'TEXT', default: 'NULL' },

    { name: 'variant_pricing', type: 'JSONB', default: "'[]'::JSONB" },

    { name: 'size_chart_data', type: 'JSONB', default: 'NULL' },

    { name: 'specifications', type: 'JSONB', default: "'{}'::JSONB" },

    { name: 'selling_points', type: 'JSONB', default: "'[]'::JSONB" },

    { name: 'inventory_by_warehouse', type: 'JSONB', default: 'NULL' },

    { name: 'inventory_status', type: 'TEXT', default: 'NULL' },

    { name: 'inventory_error_message', type: 'TEXT', default: 'NULL' },

    { name: 'price_breakdown', type: 'JSONB', default: 'NULL' },

    { name: 'cj_total_cost', type: 'NUMERIC(10,2)', default: 'NULL' },

    { name: 'cj_shipping_cost', type: 'NUMERIC(10,2)', default: 'NULL' },

    { name: 'cj_product_cost', type: 'NUMERIC(10,2)', default: 'NULL' },

    { name: 'profit_margin', type: 'NUMERIC(5,2)', default: 'NULL' },

    { name: 'color_image_map', type: 'JSONB', default: 'NULL' },

    { name: 'supplier_rating', type: 'NUMERIC(3,1)', default: 'NULL' },

    { name: 'displayed_rating', type: 'NUMERIC(3,1)', default: 'NULL' },

    { name: 'rating_confidence', type: 'NUMERIC(3,2)', default: 'NULL' },

    { name: 'review_count', type: 'INTEGER', default: '0' },

  ];



  const missingColumns: string[] = [];



  for (const col of requiredColumns) {

    try {

      const { error } = await supabase

        .from('product_queue')

        .select(col.name)

        .limit(1);



      if (error && isSchemaMissingColumnError(error, col.name)) {

        missingColumns.push(col.name);

      }

    } catch (err) {

      missingColumns.push(col.name);

    }

  }



  const migrationSQL = missingColumns.length > 0

    ? requiredColumns

        .filter(col => missingColumns.includes(col.name))

        .map(col => `ALTER TABLE product_queue ADD COLUMN IF NOT EXISTS ${col.name} ${col.type} DEFAULT ${col.default};`)

        .join('\n')

    : '';



  return {

    ready: missingColumns.length === 0,

    missingColumns,

    migrationSQL

  };

}



export async function testImportDbConnection(): Promise<{ ok: boolean; error?: string }> {

  try {

    const supabase = getSupabaseAdmin();

    if (!supabase) {

      return { ok: false, error: 'Supabase not configured' };

    }

    const { error } = await supabase.from('import_batches').select('id').limit(1);

    if (error) {

      if (error.message.includes('does not exist')) {

        return { ok: false, error: 'Import tables not found. Please run the database migration.' };

      }

      return { ok: false, error: error.message };

    }

    return { ok: true };

  } catch (e: any) {

    return { ok: false, error: e?.message || 'Connection failed' };

  }

}



export async function createImportBatch(data: {

  name: string;

  keywords: string;

  category: string;

  filters: any;

  productsFound: number;

}): Promise<{ id: number } | null> {

  const supabase = getSupabaseAdmin();

  if (!supabase) return null;



  const { data: batch, error } = await supabase

    .from('import_batches')

    .insert({

      name: data.name,

      keywords: data.keywords,

      category: data.category,

      filters: data.filters,

      status: 'active',

      products_found: data.productsFound,

      products_approved: 0,

      products_imported: 0,

    })

    .select('id')

    .single();



  if (error) {

    console.error('[Import DB] Failed to create batch:', error.message);

    return null;

  }

  return batch;

}



export async function addProductToQueue(batchId: number, product: {

  productId: string;

  cjSku?: string;

  storeSku?: string;

  name: string;

  description?: string;

  overview?: string;

  productInfo?: string;

  sizeInfo?: string;

  productNote?: string;

  packingList?: string;

  category: string;

  images: string[];

  videoUrl?: string;

  videoSourceUrl?: string;

  video4kUrl?: string;

  videoDeliveryMode?: 'native' | 'enhanced' | 'passthrough';

  videoQualityGatePassed?: boolean;

  videoSourceQualityHint?: '4k' | 'hd' | 'sd' | 'unknown';

  mediaMode?: string;

  variants: any[];

  avgPrice: number;

  supplierRating?: number;

  reviewCount?: number;

  totalSales?: number;

  totalStock: number;

  processingDays?: number;

  deliveryDaysMin?: number;

  deliveryDaysMax?: number;

  qualityScore?: number;

  displayedRating?: number;

  ratingConfidence?: number;

  weightG?: number;

  packLength?: number;

  packWidth?: number;

  packHeight?: number;

  material?: string;

  productType?: string;

  originCountry?: string;

  hsCode?: string;

  sizeChartImages?: string[];

  availableSizes?: string[];

  availableColors?: string[];

  availableModels?: string[];

  categoryName?: string;

  cjCategoryId?: string;

  supabaseCategoryId?: number;

  supabaseCategorySlug?: string;

  variantPricing?: any[];

  sizeChartData?: any;

  specifications?: Record<string, any>;

  sellingPoints?: string[];

  inventoryByWarehouse?: any;

  inventoryStatus?: string;

  inventoryErrorMessage?: string;

  priceBreakdown?: any;

  cjTotalCost?: number;

  cjShippingCost?: number;

  cjProductCost?: number;

  profitMargin?: number;

  colorImageMap?: Record<string, string>;

}, options?: {

  schemaCheck?: Awaited<ReturnType<typeof checkProductQueueSchema>>;

}): Promise<{
  success: boolean;
  error?: string;
  blockedUnavailable?: boolean;
  skippedLowQualityDowngrade?: boolean;
}> {

  const supabase = getSupabaseAdmin();

  if (!supabase) return { success: false, error: 'Supabase not configured' };

  if (!product.productId) return { success: false, error: 'Missing required field: pid' };

  if (!product.name) return { success: false, error: 'Missing required field: name' };

  if (!Array.isArray(product.variants) || product.variants.length === 0) {

    return { success: false, error: 'Missing required field: variants' };

  }

  for (const v of product.variants) {

    if (!v?.variantSku) return { success: false, error: 'Missing required field: variantSku' };

    if (v?.sellPriceSAR == null) return { success: false, error: 'Missing required field: sellPriceSAR' };

  }



  const normalizedVideoUrl = normalizeCjVideoUrl(product.videoUrl);

  const normalizedVideoSourceUrl = normalizeCjVideoUrl(product.videoSourceUrl);

  const normalizedVideo4kUrl = normalizeCjVideoUrl(product.video4kUrl);

  const canonicalVideoUrl = normalizedVideoUrl || normalizedVideo4kUrl;

  const hasVideo = typeof canonicalVideoUrl === 'string' && canonicalVideoUrl.length > 0;

  const admin = supabase as SupabaseClient;



  async function generateUniqueProductCode(client: SupabaseClient): Promise<string> {

    const gen = () => 'xo' + Math.floor(Math.random() * 1_0000_0000).toString().padStart(8, '0');

    for (let i = 0; i < 6; i++) {

      const code = gen();

      const [{ data: q1 }, { data: q2 }] = await Promise.all([

        client.from('product_queue').select('id').eq('product_code', code).limit(1),

        client.from('products').select('id').eq('product_code', code).limit(1),

      ]);

      if (!q1?.length && !q2?.length) return code;

    }

    const ts = Date.now() % 100000000;

    return 'xo' + String(ts).padStart(8, '0');

  }



  const productCode = await generateUniqueProductCode(admin);

  const storeSku = product.storeSku || productCode;

  const normalizedAvailableSizes = Array.isArray(product.availableSizes)

    ? normalizeSizeList(product.availableSizes, { allowNumeric: false })

    : [];

  const availableColorMap = new Map<string, string>();

  for (const color of Array.isArray(product.availableColors) ? product.availableColors : []) {

    const rawColor = typeof color === 'string' ? color.trim() : '';

    if (!rawColor) continue;

    const colorKey = rawColor.toLowerCase().replace(/\s+/g, ' ');

    if (!availableColorMap.has(colorKey)) {

      availableColorMap.set(colorKey, rawColor);

    }

  }

  const deduplicatedAvailableColors = Array.from(availableColorMap.values());



  const normalizedQueueImages: string[] = [];

  const seenImageKeys = new Set<string>();

  for (const imageUrl of Array.isArray(product.images) ? product.images : []) {

    if (typeof imageUrl !== 'string') continue;

    const enhanced = enhanceProductImageUrl(imageUrl.trim(), 'gallery');

    if (!/^https?:\/\//i.test(enhanced)) continue;

    const key = normalizeCjImageKey(enhanced) || enhanced;

    if (seenImageKeys.has(key)) continue;

    seenImageKeys.add(key);

    normalizedQueueImages.push(enhanced);

  }



  const normalizedColorImageMap = (() => {

    if (!product.colorImageMap || typeof product.colorImageMap !== 'object') return null;



    const entries: [string, string][] = [];

    for (const [color, imageUrl] of Object.entries(product.colorImageMap)) {

      if (typeof imageUrl !== 'string') continue;

      const enhanced = enhanceProductImageUrl(imageUrl.trim(), 'gallery');

      if (!/^https?:\/\//i.test(enhanced)) continue;

      entries.push([color, enhanced]);

    }



    return entries.length > 0 ? Object.fromEntries(entries) : null;

  })();

  const normalizedName = typeof product.name === 'string' ? product.name.trim() : '';
  const normalizedCategory =
    (typeof product.categoryName === 'string' && product.categoryName.trim()) ||
    (typeof product.category === 'string' && product.category.trim()) ||
    '';
  const hasRealName = !isPlaceholderQueueNameForInsert(normalizedName);
  const hasRealCategory = !isPlaceholderQueueCategoryForInsert(normalizedCategory);
  const hasRealGallery = normalizedQueueImages.length > 0 || Boolean(normalizedColorImageMap && Object.keys(normalizedColorImageMap).length > 0);
  const hasRealVariants = hasMeaningfulQueueInsertVariantData(Array.isArray(product.variants) ? product.variants : []);
  const failedChecks: string[] = [];
  if (!hasRealName) failedChecks.push('name');
  if (!hasRealCategory) failedChecks.push('category');
  if (!hasRealGallery) failedChecks.push('images');
  if (!hasRealVariants) failedChecks.push('variants');
  const isLowQualityCandidate = failedChecks.length > 0;
  const ingestionBlockedMessage = isLowQualityCandidate
    ? `${IMPORT_QUEUE_INGESTION_BLOCK_PREFIX}:${failedChecks.join(',')}:${new Date().toISOString()}`
    : null;



  const imagesCount = Array.isArray(product.images) ? product.images.length : 0;

  const vpArray: any[] = Array.isArray(product.variantPricing) ? product.variantPricing : [];

  const usdCandidates: number[] = [];

  for (const vp of vpArray) {

    const c = Number(vp?.costPrice);

    if (Number.isFinite(c) && c > 0) usdCandidates.push(c);

  }

  if (Array.isArray(product.variants)) {

    for (const v of product.variants) {

      const c = Number(v?.variantPriceUSD ?? v?.variantPrice);

      if (Number.isFinite(c) && c > 0) usdCandidates.push(c);

    }

  }

  const fallbackAvgUsd = Number((product as any).avgPriceUsd)

    || (Number(product.avgPrice) ? sarToUsd(Number(product.avgPrice)) : 0);

  const minVariantUsd = usdCandidates.length > 0 ? Math.min(...usdCandidates) : fallbackAvgUsd;

  const imgNorm = Math.max(0, Math.min(1, imagesCount / 15));

  const priceNorm = Math.max(0, Math.min(1, minVariantUsd / 50));

  const dynQuality = Math.max(0, Math.min(1, 0.6 * imgNorm + 0.4 * (1 - priceNorm)));



  const ratingSignals = {

    imageCount: imagesCount,

    stock: product.totalStock || 0,

    variantCount: Array.isArray(product.variants) ? product.variants.length : 0,

    qualityScore: typeof product.qualityScore === 'number'

      ? Math.max(0, Math.min(1, product.qualityScore))

      : dynQuality,

    priceUsd: minVariantUsd,

    sentiment: 0,

    orderVolume: 0,

  };

  const ratingOut = computeRating(ratingSignals);

  const resolvedSupplierRating = normalizeQueueRatingValue(product.supplierRating);

  const reviewCountRaw = Number(product.reviewCount);

  const resolvedReviewCount = Number.isFinite(reviewCountRaw) && reviewCountRaw >= 0

    ? Math.floor(reviewCountRaw)

    : null;

  const resolvedDisplayedRating = normalizeQueueRatingValue(product.displayedRating);

  const resolvedRatingConfidence = typeof product.ratingConfidence === 'number' && Number.isFinite(product.ratingConfidence) && product.ratingConfidence > 0

    ? Math.max(0.05, Math.min(1, product.ratingConfidence))

    : null;



  // Core fields that always exist

  const productData: Record<string, any> = {

    batch_id: batchId,

    cj_product_id: product.productId,

    cj_sku: product.cjSku || null,

    store_sku: storeSku,

    name_en: product.name,

    name_ar: null,

    description_en: product.description || null,

    description_ar: null,

    overview: product.overview || null,

    product_info: product.productInfo || null,

    size_info: product.sizeInfo || null,

    product_note: product.productNote || null,

    packing_list: product.packingList || null,

    category: product.category,

    images: normalizedQueueImages.length > 0 ? normalizedQueueImages : product.images,

    variants: product.variants,

    cj_price_usd: minVariantUsd,

    shipping_cost_usd: null,

    calculated_retail_sar: null,

    margin_applied: null,

    total_sales: product.totalSales ?? null,

    stock_total: product.totalStock,

    processing_days: product.processingDays ?? null,

    delivery_days_min: product.deliveryDaysMin ?? null,

    delivery_days_max: product.deliveryDaysMax ?? null,

    quality_score: product.qualityScore ?? null,

    displayed_rating: resolvedDisplayedRating,

    rating_confidence: resolvedRatingConfidence,

    status: 'pending',

    admin_notes: null,

    reviewed_by: null,

    reviewed_at: null,

    shopixo_product_id: null,

    imported_at: null,

    updated_at: new Date().toISOString(),

    weight_g: product.weightG || null,

    pack_length: product.packLength || null,

    pack_width: product.packWidth || null,

    pack_height: product.packHeight || null,

    material: product.material || null,

    product_type: product.productType || null,

    origin_country: product.originCountry || null,

    hs_code: product.hsCode || null,

    category_name: product.categoryName || null,

    size_chart_images: product.sizeChartImages || null,

    available_sizes: normalizedAvailableSizes.length > 0 ? normalizedAvailableSizes : null,

    available_colors: deduplicatedAvailableColors.length > 0 ? deduplicatedAvailableColors : null,

    available_models: product.availableModels || null,

    cj_category_id: product.cjCategoryId || null,

    supabase_category_id: product.supabaseCategoryId || null,

    supabase_category_slug: product.supabaseCategorySlug || null,

    inventory_status: isLowQualityCandidate ? 'blocked_unavailable' : (product.inventoryStatus || null),

    inventory_error_message: isLowQualityCandidate ? ingestionBlockedMessage : (product.inventoryErrorMessage || null),

  };

  

  // New columns that require migration - check if they exist first

  const newColumns: Record<string, any> = {

    supplier_rating: resolvedSupplierRating,

    review_count: resolvedReviewCount,

    variant_pricing: product.variantPricing || [],

    size_chart_data: product.sizeChartData || null,

    specifications: product.specifications || {},

    selling_points: product.sellingPoints || [],

    inventory_by_warehouse: product.inventoryByWarehouse || null,

    price_breakdown: product.priceBreakdown || null,

    cj_total_cost: product.cjTotalCost || null,

    cj_shipping_cost: product.cjShippingCost || null,

    cj_product_cost: product.cjProductCost || null,

    profit_margin: product.profitMargin || null,

    color_image_map: normalizedColorImageMap,

    product_code: productCode,

    video_url: canonicalVideoUrl || null,

    video_source_url: normalizedVideoSourceUrl || null,

    video_4k_url: normalizedVideo4kUrl || null,

    video_delivery_mode: product.videoDeliveryMode || null,

    video_quality_gate_passed: typeof product.videoQualityGatePassed === 'boolean' ? product.videoQualityGatePassed : null,

    video_source_quality_hint: product.videoSourceQualityHint || null,

    media_mode: product.mediaMode || null,

    has_video: hasVideo,

  };

  

  // Check which new columns exist in the schema

  const schemaCheck = options?.schemaCheck || await checkProductQueueSchema();

  if (schemaCheck.ready) {

    // All new columns exist, add them to productData

    Object.assign(productData, newColumns);

  } else {

    // Only add columns that exist

    for (const col of Object.keys(newColumns)) {

      if (!schemaCheck.missingColumns.includes(col)) {

        productData[col] = newColumns[col];

      }

    }

  }



  const writeProductQueue = async (payload: Record<string, any>): Promise<{
    error: any;
    skippedLowQualityDowngrade: boolean;
    blockedUnavailable: boolean;
  }> => {

    const { data: existing } = await supabase

      .from('product_queue')

      .select('id, name_en, category, category_name, images, variants, color_image_map')

      .eq('cj_product_id', product.productId)

      .maybeSingle();



    if (existing) {
      if (isLowQualityCandidate && isQueueRowHighFidelityForDowngradeGuard(existing)) {
        return {
          error: null,
          skippedLowQualityDowngrade: true,
          blockedUnavailable: false,
        };
      }
      const updateResult = await supabase

        .from('product_queue')

        .update(payload)

        .eq('cj_product_id', product.productId);

      return {
        error: updateResult.error,
        skippedLowQualityDowngrade: false,
        blockedUnavailable: isLowQualityCandidate,
      };

    }



    const insertResult = await supabase

      .from('product_queue')

      .insert(payload);

    return {
      error: insertResult.error,
      skippedLowQualityDowngrade: false,
      blockedUnavailable: isLowQualityCandidate,
    };

  };



  let payloadForWrite: Record<string, any> = { ...productData };

  let writeResult = await writeProductQueue(payloadForWrite);
  let error = writeResult.error;
  let skippedLowQualityDowngrade = writeResult.skippedLowQualityDowngrade;
  let blockedUnavailable = writeResult.blockedUnavailable;



  if (error && isSchemaMissingColumnError(error)) {

    const optionalColumns = new Set(Object.keys(newColumns));

    const columnsFromError = extractMissingColumnNames(error);

    const columnsToStrip = new Set<string>();



    for (const column of columnsFromError) {

      if (optionalColumns.has(column)) {

        columnsToStrip.add(column);

      }

    }



    if (columnsToStrip.size === 0) {

      for (const column of optionalColumns) {

        if (isSchemaMissingColumnError(error, column)) {

          columnsToStrip.add(column);

        }

      }

    }



    if (columnsToStrip.size > 0) {

      const retryPayload = { ...payloadForWrite };

      for (const column of columnsToStrip) {

        delete retryPayload[column];

      }



      console.warn('[Import DB] Retrying addProductToQueue without missing optional columns', {

        productId: product.productId,

        columns: Array.from(columnsToStrip),

      });



      payloadForWrite = retryPayload;

      writeResult = await writeProductQueue(payloadForWrite);

      error = writeResult.error;
      skippedLowQualityDowngrade = writeResult.skippedLowQualityDowngrade;
      blockedUnavailable = writeResult.blockedUnavailable;

    }

  }



  if (error) {

    // Provide clearer error message for schema cache issues

    let errorMsg = `${error.message} (code: ${error.code})`;

    if (isSchemaMissingColumnError(error)) {

      errorMsg = `Database schema cache is outdated. Please go to Supabase Dashboard → Settings → API → click "Reload schema" to refresh. Original error: ${error.message}`;

    }

    if (error.details) {

      errorMsg += ` - ${error.details}`;

    }

    console.error('[Import DB] Failed to add product to queue:', {

      message: error.message,

      code: error.code,

      details: error.details,

      hint: error.hint,

      productId: product.productId

    });

    return { success: false, error: errorMsg };

  }



  try {

    const signalsTable = await hasTable('product_rating_signals').catch(() => false);

    if (signalsTable) {

      await supabase.from('product_rating_signals').insert({

        product_id: null,

        cj_product_id: product.productId,

        context: 'queue',

        signals: ratingOut.signals,

        displayed_rating: productData.displayed_rating,

        rating_confidence: productData.rating_confidence,

      });

    }

  } catch {

    // Non-fatal

  }



  return {
    success: true,
    blockedUnavailable,
    skippedLowQualityDowngrade,
  };

}



export async function logImportAction(batchId: number, action: string, status: string, details: any): Promise<void> {

  const supabase = getSupabaseAdmin();

  if (!supabase) return;



  await supabase.from('import_logs').insert({

    batch_id: batchId,

    action,

    status,

    details,

  });

}



export async function getQueuedProducts(options: {

  status?: string;

  batchId?: number;

  limit?: number;

  offset?: number;

}): Promise<any[]> {

  const supabase = getSupabaseAdmin();

  if (!supabase) return [];



  let query = supabase.from('product_queue').select('*');



  if (options.status) {

    query = query.eq('status', options.status);

  }

  if (options.batchId) {

    query = query.eq('batch_id', options.batchId);

  }

  

  query = query.order('created_at', { ascending: false });

  

  if (options.limit) {

    query = query.limit(options.limit);

  }

  if (options.offset) {

    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);

  }



  const { data, error } = await query;

  if (error) {

    console.error('[Import DB] Failed to get queued products:', error.message);

    return [];

  }

  return data || [];

}



export async function updateProductStatus(productId: string, status: string, notes?: string): Promise<boolean> {

  const supabase = getSupabaseAdmin();

  if (!supabase) return false;



  const { error } = await supabase

    .from('product_queue')

    .update({

      status,

      admin_notes: notes || null,

      reviewed_at: new Date().toISOString(),

    })

    .eq('cj_product_id', productId);



  if (error) {

    console.error('[Import DB] Failed to update product status:', error.message);

    return false;

  }

  return true;

}



export async function getBatches(limit: number = 50): Promise<any[]> {

  const supabase = getSupabaseAdmin();

  if (!supabase) return [];



  const { data, error } = await supabase

    .from('import_batches')

    .select('*')

    .order('created_at', { ascending: false })

    .limit(limit);



  if (error) {

    console.error('[Import DB] Failed to get batches:', error.message);

    return [];

  }

  return data || [];

}



export async function getQueueStats(): Promise<{ pending: number; approved: number; rejected: number; imported: number }> {

  const supabase = getSupabaseAdmin();

  if (!supabase) return { pending: 0, approved: 0, rejected: 0, imported: 0 };



  const [pending, approved, rejected, imported] = await Promise.all([

    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending'),

    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'approved'),

    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),

    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'imported'),

  ]);



  return {

    pending: pending.count || 0,

    approved: approved.count || 0,

    rejected: rejected.count || 0,

    imported: imported.count || 0,

  };

}

