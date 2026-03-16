import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enhanceProductImageUrl } from "@/lib/media/image-quality";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function isDbConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeHttpUrl(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

function parseQueueArray(value: unknown): any[] {
  const parsed = parseJsonMaybe(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseQueueStringArray(value: unknown): string[] {
  const parsed = parseJsonMaybe(value);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item: unknown): string => (typeof item === "string" ? item.trim() : ""))
      .filter((item: string) => item.length > 0);
  }
  if (isNonEmptyString(parsed)) {
    if (!parsed.includes(",")) return [parsed.trim()];
    return parsed
      .split(",")
      .map((item: string): string => item.trim())
      .filter((item: string) => item.length > 0);
  }
  return [];
}

function normalizeQueueColorImageMap(value: unknown): Record<string, string> | null {
  const parsed = parseJsonMaybe(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const normalized = normalizeHttpUrl(v);
    if (normalized) out[k] = normalized;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractImageCandidates(input: unknown): unknown[] {
  const parsed = parseJsonMaybe(input);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return Object.values(parsed as Record<string, unknown>);
  if (parsed == null) return [];
  return [parsed];
}

function normalizeQueueImages(value: unknown): string[] {
  const source = extractImageCandidates(value);
  const out: string[] = [];
  const seen = new Set<string>();
  const objectImageKeys = ["url", "image", "img", "src", "imageUrl", "mainImage", "thumbnail"];

  const pushCandidate = (candidate: unknown) => {
    const normalizedUrl = normalizeHttpUrl(candidate);
    if (!normalizedUrl) return;
    const enhanced = enhanceProductImageUrl(normalizedUrl, "gallery");
    const key = enhanced.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(enhanced);
  };

  for (const item of source) {
    if (typeof item === "string") {
      pushCandidate(item);
      continue;
    }

    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of objectImageKeys) {
        if (record[key] !== undefined) pushCandidate(record[key]);
      }
    }
  }

  return out;
}

function deriveQueueBaseCostUsd(product: any, variantPricing: any[], variants: any[]): number {
  const direct = Number(product?.cj_price_usd);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const pricingCandidates = variantPricing
    .map((v: any) => Number(v?.costPrice ?? v?.variantPriceUSD ?? v?.variantPrice ?? v?.cost))
    .filter((value: number) => Number.isFinite(value) && value > 0);
  if (pricingCandidates.length > 0) return Math.min(...pricingCandidates);

  const variantCandidates = variants
    .map((v: any) => Number(v?.variantPriceUSD ?? v?.variantPrice ?? v?.costPrice ?? v?.price))
    .filter((value: number) => Number.isFinite(value) && value > 0);
  if (variantCandidates.length > 0) return Math.min(...variantCandidates);

  return 0;
}

function deriveQueueStockTotal(product: any, variants: any[]): number {
  const direct = Number(product?.stock_total);
  if (Number.isFinite(direct) && direct >= 0) return Math.floor(direct);

  const fromVariants = variants
    .map((v: any) =>
      Number(v?.stock ?? v?.totalStock ?? (Number(v?.cjStock || 0) + Number(v?.factoryStock || 0)))
    )
    .filter((value: number) => Number.isFinite(value) && value >= 0);

  if (fromVariants.length === 0) return 0;
  return Math.floor(fromVariants.reduce((sum, value) => sum + value, 0));
}

const PLACEHOLDER_QUEUE_CATEGORY_TOKENS = new Set([
  "general",
  "uncategorized",
  "unknown",
  "misc",
  "others",
]);
const QUEUE_STATUS_VALUES = ["all", "pending", "approved", "rejected", "imported"] as const;
type QueueStatusFilter = (typeof QUEUE_STATUS_VALUES)[number];
const QUEUE_STATUS_SET = new Set<string>(QUEUE_STATUS_VALUES);

function toFiniteNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toPositiveNumberOrNull(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function parsePositiveIntegerOrNull(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function parseQueueStatusFilter(value: unknown, fallback: QueueStatusFilter = "all"): QueueStatusFilter {
  const normalized = String(value || "").trim().toLowerCase();
  if (QUEUE_STATUS_SET.has(normalized)) {
    return normalized as QueueStatusFilter;
  }
  return fallback;
}

function parseQueueIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = value
    .map((item: unknown): number => Number(item))
    .filter((item: number): boolean => Number.isFinite(item) && item > 0)
    .map((item: number): number => Math.floor(item));
  return Array.from(new Set(out));
}

function isPlaceholderQueueName(value: unknown): boolean {
  if (!isNonEmptyString(value)) return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (/^cj product\b/.test(normalized)) return true;
  if (/^unavailable cj product\b/.test(normalized)) return true;
  if (/^unknown product\b/.test(normalized)) return true;
  return false;
}

function isPlaceholderQueueCategory(value: unknown): boolean {
  if (!isNonEmptyString(value)) return true;
  const normalized = value.trim().toLowerCase();
  return PLACEHOLDER_QUEUE_CATEGORY_TOKENS.has(normalized);
}

function pickDisplayName(product: any): string {
  const candidates = [product?.display_name, product?.name_en, product?.name, product?.title, product?.product_name];
  const preferred = candidates.find((value) => isNonEmptyString(value) && !isPlaceholderQueueName(value));
  if (preferred) return preferred.trim();
  const fallback = candidates.find((value) => isNonEmptyString(value));
  if (fallback) return String(fallback).trim();
  return `CJ Product ${String(product?.cj_product_id || "").slice(-10)}`;
}

function pickDisplayCategory(product: any): string {
  const candidates = [product?.display_category, product?.category_name, product?.category];
  const preferred = candidates.find((value) => isNonEmptyString(value) && !isPlaceholderQueueCategory(value));
  if (preferred) return preferred.trim();
  const fallback = candidates.find((value) => isNonEmptyString(value));
  if (fallback) return String(fallback).trim();
  return "General";
}

function hasMeaningfulVariantData(variants: any[]): boolean {
  return variants.some((variant: any) => {
    if (!variant || typeof variant !== "object") return false;
    if (isNonEmptyString(variant?.color) || isNonEmptyString(variant?.size)) return true;
    const stock = toFiniteNumber(
      variant?.stock ?? variant?.totalStock ?? (toFiniteNumber(variant?.cjStock, 0) + toFiniteNumber(variant?.factoryStock, 0)),
      0
    );
    if (stock > 0) return true;
    const cost = toFiniteNumber(variant?.variantPriceUSD ?? variant?.variantPrice ?? variant?.costPrice ?? variant?.price, 0);
    return cost > 0;
  });
}

function normalizeQueueProductRow(product: any) {
  const parsedVariants = parseQueueArray(product?.variants);
  const parsedVariantPricing = parseQueueArray(product?.variant_pricing);
  const parsedColorImageMap = normalizeQueueColorImageMap(product?.color_image_map);

  let normalizedImages = normalizeQueueImages(product?.images);
  if (normalizedImages.length === 0) normalizedImages = normalizeQueueImages(product?.image);
  if (normalizedImages.length === 0 && parsedColorImageMap) {
    normalizedImages = normalizeQueueImages(Object.values(parsedColorImageMap));
  }
  if (normalizedImages.length === 0) {
    normalizedImages = normalizeQueueImages(
      parsedVariants.map((variant: any) => variant?.variantImage || variant?.colorImage || variant?.image)
    );
  }

  let availableColors = parseQueueStringArray(product?.available_colors);
  if (availableColors.length === 0) {
    availableColors = parsedVariants
      .map((variant: any): string => (isNonEmptyString(variant?.color) ? variant.color.trim() : ""))
      .filter((value: string) => value.length > 0);
  }

  let availableSizes = parseQueueStringArray(product?.available_sizes);
  if (availableSizes.length === 0) {
    availableSizes = parsedVariants
      .map((variant: any): string => (isNonEmptyString(variant?.size) ? variant.size.trim() : ""))
      .filter((value: string) => value.length > 0);
  }

  const displayName = pickDisplayName(product);
  const displayCategory = pickDisplayCategory(product);

  return {
    ...product,
    name_en: isNonEmptyString(product?.name_en) ? product.name_en : displayName,
    category: isNonEmptyString(product?.category) ? product.category : displayCategory,
    images: normalizedImages,
    variants: parsedVariants,
    variant_pricing: parsedVariantPricing,
    available_colors: availableColors,
    available_sizes: availableSizes,
    color_image_map: parsedColorImageMap || product?.color_image_map || null,
    display_name: displayName,
    display_category: displayCategory,
    cj_price_usd: deriveQueueBaseCostUsd(product, parsedVariantPricing, parsedVariants),
    stock_total: deriveQueueStockTotal(product, parsedVariants),
  };
}

function isQueueProductStaleForDisplay(product: any): boolean {
  const displayName = pickDisplayName(product);
  const displayCategory = pickDisplayCategory(product);
  const images = normalizeQueueImages(product?.images);
  const variants = parseQueueArray(product?.variants);
  const variantPricing = parseQueueArray(product?.variant_pricing);
  const colors = parseQueueStringArray(product?.available_colors);
  const sizes = parseQueueStringArray(product?.available_sizes);
  const baseCost = deriveQueueBaseCostUsd(product, variantPricing, variants);
  const stockTotal = deriveQueueStockTotal(product, variants);
  const rating = toPositiveNumberOrNull(product?.displayed_rating) ?? toPositiveNumberOrNull(product?.supplier_rating);
  const reviewCount = Math.floor(Math.max(0, toFiniteNumber(product?.review_count, 0)));

  let staleSignals = 0;
  if (isPlaceholderQueueName(displayName)) staleSignals += 2;
  if (images.length === 0) staleSignals += 2;
  if (isPlaceholderQueueCategory(displayCategory)) staleSignals += 1;
  if (baseCost <= 0) staleSignals += 1;
  if (stockTotal <= 0 && !hasMeaningfulVariantData(variants)) staleSignals += 1;
  if (colors.length === 0 && sizes.length === 0 && variants.length <= 1) staleSignals += 1;
  if (rating == null && reviewCount <= 0) staleSignals += 1;
  return staleSignals >= 2;
}

function buildQueueVariantPricingFromPreviewVariants(variants: any[]): any[] {
  if (!Array.isArray(variants) || variants.length === 0) return [];
  return variants.map((variant: any, index: number) => {
    const color = isNonEmptyString(variant?.color) ? variant.color.trim() : "";
    const size = isNonEmptyString(variant?.size) ? variant.size.trim() : "";
    const variantId =
      (isNonEmptyString(variant?.variantId) && variant.variantId.trim()) ||
      (isNonEmptyString(variant?.vid) && variant.vid.trim()) ||
      `${index + 1}`;
    const variantSku =
      (isNonEmptyString(variant?.variantSku) && variant.variantSku.trim()) ||
      (isNonEmptyString(variant?.sku) && variant.sku.trim()) ||
      variantId;
    const variantImage =
      normalizeHttpUrl(variant?.variantImage) ||
      normalizeHttpUrl(variant?.colorImage) ||
      normalizeHttpUrl(variant?.image) ||
      null;
    const sellPriceSAR = toPositiveNumberOrNull(variant?.sellPriceSAR ?? variant?.price ?? variant?.sellPriceSar);
    const sellPriceUSD = toPositiveNumberOrNull(variant?.sellPriceUSD ?? variant?.sellPriceUsd ?? variant?.priceUsd);
    const costPrice = toPositiveNumberOrNull(variant?.variantPriceUSD ?? variant?.variantPrice ?? variant?.costPrice);
    const shippingCost = toPositiveNumberOrNull(variant?.shippingPriceUSD ?? variant?.shippingCost ?? variant?.shippingPrice);
    const stock = Math.max(
      0,
      Math.floor(
        toFiniteNumber(
          variant?.stock ??
            variant?.totalStock ??
            (toFiniteNumber(variant?.cjStock, 0) + toFiniteNumber(variant?.factoryStock, 0)),
          0
        )
      )
    );

    return {
      variantId,
      sku: variantSku,
      color: color || undefined,
      size: size || undefined,
      colorImage: variantImage || undefined,
      price: sellPriceSAR ?? undefined,
      priceUsd: sellPriceUSD ?? undefined,
      marginPercent: toPositiveNumberOrNull(variant?.marginPercent ?? variant?.profitMargin ?? variant?.margin) ?? undefined,
      costPrice: costPrice ?? undefined,
      shippingCost: shippingCost ?? undefined,
      stock,
      cjStock: Math.max(0, Math.floor(toFiniteNumber(variant?.cjStock, stock))),
      factoryStock: Math.max(0, Math.floor(toFiniteNumber(variant?.factoryStock, 0))),
    };
  });
}

function derivePreviewBaseCostUsd(previewProduct: any, previewVariantPricing: any[], previewVariants: any[]): number {
  const directCandidates = previewVariants
    .map((variant: any) => toPositiveNumberOrNull(variant?.variantPriceUSD ?? variant?.variantPrice ?? variant?.costPrice ?? variant?.priceUSD))
    .filter((value: number | null): value is number => typeof value === "number");
  if (directCandidates.length > 0) return Math.min(...directCandidates);

  const pricingCandidates = previewVariantPricing
    .map((variant: any) => toPositiveNumberOrNull(variant?.costPrice ?? variant?.variantPriceUSD ?? variant?.variantPrice ?? variant?.cost))
    .filter((value: number | null): value is number => typeof value === "number");
  if (pricingCandidates.length > 0) return Math.min(...pricingCandidates);

  const minPriceUSD = toPositiveNumberOrNull(previewProduct?.minPriceUSD);
  return minPriceUSD ?? 0;
}

function mergeQueueProductWithPreview(baseProduct: any, previewProduct: any): any {
  if (!previewProduct || typeof previewProduct !== "object") return baseProduct;

  const merged = { ...baseProduct };
  const previewName = isNonEmptyString(previewProduct?.name) ? previewProduct.name.trim() : "";
  if (previewName && (isPlaceholderQueueName(merged?.name_en) || !isNonEmptyString(merged?.name_en))) {
    merged.name_en = previewName;
  }

  const previewCategory = isNonEmptyString(previewProduct?.categoryName) ? previewProduct.categoryName.trim() : "";
  if (previewCategory) {
    if (!isNonEmptyString(merged?.category_name) || isPlaceholderQueueCategory(merged?.category_name)) {
      merged.category_name = previewCategory;
    }
    if (!isNonEmptyString(merged?.category) || isPlaceholderQueueCategory(merged?.category)) {
      merged.category = previewCategory;
    }
  }

  const previewImages = normalizeQueueImages(previewProduct?.images);
  if (previewImages.length > 0 && normalizeQueueImages(merged?.images).length === 0) {
    merged.images = previewImages;
  }

  const previewVariants = Array.isArray(previewProduct?.variants) ? previewProduct.variants : [];
  if (previewVariants.length > 0) {
    const currentVariants = parseQueueArray(merged?.variants);
    if (currentVariants.length === 0 || !hasMeaningfulVariantData(currentVariants)) {
      merged.variants = previewVariants;
    }
  }

  const previewVariantPricing = buildQueueVariantPricingFromPreviewVariants(previewVariants);
  if (previewVariantPricing.length > 0 && parseQueueArray(merged?.variant_pricing).length === 0) {
    merged.variant_pricing = previewVariantPricing;
  }

  let previewColors = parseQueueStringArray(previewProduct?.availableColors);
  if (previewColors.length === 0) {
    previewColors = previewVariants
      .map((variant: any): string => (isNonEmptyString(variant?.color) ? variant.color.trim() : ""))
      .filter((value: string) => value.length > 0);
  }
  if (previewColors.length > 0 && parseQueueStringArray(merged?.available_colors).length === 0) {
    merged.available_colors = Array.from(new Set(previewColors));
  }

  let previewSizes = parseQueueStringArray(previewProduct?.availableSizes);
  if (previewSizes.length === 0) {
    previewSizes = previewVariants
      .map((variant: any): string => (isNonEmptyString(variant?.size) ? variant.size.trim() : ""))
      .filter((value: string) => value.length > 0);
  }
  if (previewSizes.length > 0 && parseQueueStringArray(merged?.available_sizes).length === 0) {
    merged.available_sizes = Array.from(new Set(previewSizes));
  }

  const previewBaseCostUsd = derivePreviewBaseCostUsd(previewProduct, previewVariantPricing, previewVariants);
  if (!(toPositiveNumberOrNull(merged?.cj_price_usd) != null) && previewBaseCostUsd > 0) {
    merged.cj_price_usd = previewBaseCostUsd;
  }

  const previewStock = Math.floor(Math.max(0, toFiniteNumber(previewProduct?.stock, 0)));
  if (toFiniteNumber(merged?.stock_total, 0) <= 0 && previewStock > 0) {
    merged.stock_total = previewStock;
  }

  const previewDisplayedRating = toPositiveNumberOrNull(previewProduct?.displayedRating);
  if (!(toPositiveNumberOrNull(merged?.displayed_rating) != null) && previewDisplayedRating != null) {
    merged.displayed_rating = previewDisplayedRating;
  }

  const previewSupplierRating = toPositiveNumberOrNull(previewProduct?.rating);
  if (!(toPositiveNumberOrNull(merged?.supplier_rating) != null) && previewSupplierRating != null) {
    merged.supplier_rating = previewSupplierRating;
  }

  const previewReviewCountRaw = Number(previewProduct?.reviewCount);
  const previewReviewCount = Number.isFinite(previewReviewCountRaw) ? Math.max(0, Math.floor(previewReviewCountRaw)) : 0;
  const currentReviewCount = Number(merged?.review_count);
  if ((!Number.isFinite(currentReviewCount) || currentReviewCount <= 0) && previewReviewCount > 0) {
    merged.review_count = previewReviewCount;
  }

  const previewRatingConfidence = toPositiveNumberOrNull(previewProduct?.ratingConfidence);
  if (!(toPositiveNumberOrNull(merged?.rating_confidence) != null) && previewRatingConfidence != null) {
    merged.rating_confidence = Math.max(0.05, Math.min(1, previewRatingConfidence));
  }

  if (!isNonEmptyString(merged?.store_sku) && isNonEmptyString(previewProduct?.storeSku)) {
    merged.store_sku = previewProduct.storeSku.trim();
  }
  if (!isNonEmptyString(merged?.cj_sku) && isNonEmptyString(previewProduct?.cjSku)) {
    merged.cj_sku = previewProduct.cjSku.trim();
  }

  return merged;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.0001;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return String(left) === String(right);
  }
}

function buildEnrichmentPatch(originalProduct: any, mergedProduct: any): Record<string, any> {
  const patchableFields = [
    "name_en",
    "category",
    "category_name",
    "images",
    "variants",
    "variant_pricing",
    "available_colors",
    "available_sizes",
    "cj_price_usd",
    "stock_total",
    "displayed_rating",
    "supplier_rating",
    "rating_confidence",
    "review_count",
    "store_sku",
    "cj_sku",
  ];
  const patch: Record<string, any> = {};
  for (const field of patchableFields) {
    if (!valuesEqual(originalProduct?.[field], mergedProduct?.[field])) {
      patch[field] = mergedProduct?.[field] ?? null;
    }
  }
  return patch;
}

async function fetchPreviewProductForQueue(req: NextRequest, pid: string): Promise<any | null> {
  const normalizedPid = String(pid || "").trim();
  if (!normalizedPid) return null;

  const origin = req.nextUrl.origin;
  if (!origin) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(
      `${origin}/api/admin/cj/products/${encodeURIComponent(normalizedPid)}/details`,
      {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          cookie: req.headers.get("cookie") || "",
          "x-queue-enrich": "1",
        },
      }
    );
    if (!res.ok) return null;
    const payload = await res.json();
    if (!payload?.ok || !payload?.product) return null;
    return payload.product;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

type QueueEnrichmentStats = {
  scannedRows: number;
  staleRows: number;
  previewHits: number;
  previewMisses: number;
  mergedRows: number;
  persistedRows: number;
  persistFailures: number;
};

type QueueEnrichmentOptions = {
  concurrency?: number;
  persist?: boolean;
  allRows?: boolean;
};

async function enrichQueueRowsWithStats(
  req: NextRequest,
  supabase: any,
  rawProducts: any[],
  normalizedProducts: any[],
  options: QueueEnrichmentOptions = {}
): Promise<{ products: any[]; stats: QueueEnrichmentStats }> {
  const stats: QueueEnrichmentStats = {
    scannedRows: rawProducts.length,
    staleRows: 0,
    previewHits: 0,
    previewMisses: 0,
    mergedRows: 0,
    persistedRows: 0,
    persistFailures: 0,
  };

  const staleIndexes = normalizedProducts.reduce<number[]>((out, product, index) => {
    if (isQueueProductStaleForDisplay(product)) out.push(index);
    return out;
  }, []);
  stats.staleRows = staleIndexes.length;
  const targetIndexes = options.allRows
    ? normalizedProducts.map((_: any, index: number) => index)
    : staleIndexes;

  if (targetIndexes.length === 0) {
    return { products: rawProducts, stats };
  }

  const output = [...rawProducts];
  const concurrency = clampInteger(options.concurrency ?? 3, 1, 6, 3);
  const shouldPersist = options.persist !== false;

  for (let i = 0; i < targetIndexes.length; i += concurrency) {
    const batchIndexes = targetIndexes.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batchIndexes.map(async (index) => {
        const currentRaw = rawProducts[index];
        const pid = String(currentRaw?.cj_product_id || "").trim();
        if (!pid) return { previewHit: false, merged: false, persisted: false, persistFailed: false } as const;

        const previewProduct = await fetchPreviewProductForQueue(req, pid);
        if (!previewProduct) {
          return { previewHit: false, merged: false, persisted: false, persistFailed: false } as const;
        }

        const mergedProduct = mergeQueueProductWithPreview(currentRaw, previewProduct);
        const patch = buildEnrichmentPatch(currentRaw, mergedProduct);
        const hasPatch = Object.keys(patch).length > 0;
        let persisted = false;
        let persistFailed = false;

        if (hasPatch && shouldPersist) {
          const updatePayload = { ...patch, updated_at: new Date().toISOString() };
          try {
            let updateQuery = supabase.from("product_queue").update(updatePayload);
            const numericId = Number(currentRaw?.id);
            if (Number.isFinite(numericId) && numericId > 0) {
              updateQuery = updateQuery.eq("id", numericId);
            } else {
              updateQuery = updateQuery.eq("cj_product_id", pid);
            }
            const { error } = await updateQuery;
            if (error) {
              persistFailed = true;
              console.warn("[Queue GET] Failed to persist enrichment patch:", {
                id: currentRaw?.id,
                pid,
                error: error.message,
              });
            } else {
              persisted = true;
            }
          } catch (persistError: any) {
            persistFailed = true;
            console.warn("[Queue GET] Enrichment persist exception:", {
              id: currentRaw?.id,
              pid,
              error: persistError?.message || String(persistError),
            });
          }
        }
        return {
          previewHit: true,
          merged: hasPatch,
          persisted,
          persistFailed,
          index,
          mergedProduct,
        } as const;
      })
    );

    for (const result of batchResults) {
      if (!result) continue;
      if (result.previewHit) stats.previewHits += 1;
      else stats.previewMisses += 1;
      if (result.merged) stats.mergedRows += 1;
      if (result.persisted) stats.persistedRows += 1;
      if (result.persistFailed) stats.persistFailures += 1;
      if ("index" in result && typeof result.index === "number") {
        output[result.index] = result.mergedProduct;
      }
    }
  }

  return { products: output, stats };
}

async function enrichStaleQueueRows(
  req: NextRequest,
  supabase: any,
  rawProducts: any[],
  normalizedProducts: any[]
): Promise<any[]> {
  const { products } = await enrichQueueRowsWithStats(req, supabase, rawProducts, normalizedProducts, {
    concurrency: 3,
    persist: true,
  });
  return products;
}

type QueueBackfillChunkResult = {
  status: QueueStatusFilter;
  cursor: number | null;
  nextCursor: number | null;
  chunkSize: number;
  done: boolean;
  stats: QueueEnrichmentStats;
};

async function runQueueBackfillChunk(
  req: NextRequest,
  supabase: any,
  input: {
    status: QueueStatusFilter;
    cursor: number | null;
    chunkSize: number;
    ids: number[];
    concurrency: number;
  }
): Promise<QueueBackfillChunkResult> {
  const targetIds = Array.from(new Set(input.ids));
  let query = supabase.from("product_queue").select("*").order("id", { ascending: true });

  if (targetIds.length > 0) {
    query = query.in("id", targetIds);
    if (input.status !== "all") {
      query = query.eq("status", input.status);
    }
  } else {
    if (input.status !== "all") {
      query = query.eq("status", input.status);
    }
    if (input.cursor != null) {
      query = query.gt("id", input.cursor);
    }
    query = query.limit(input.chunkSize);
  }

  const { data: rows, error } = await query;
  if (error) {
    throw new Error(error.message || "Failed to query queue backfill chunk");
  }

  const rawRows = rows || [];
  const normalizedRows = rawRows.map((row: any) => normalizeQueueProductRow(row));
  const { stats } = await enrichQueueRowsWithStats(req, supabase, rawRows, normalizedRows, {
    concurrency: input.concurrency,
    persist: true,
    allRows: true,
  });

  const done = targetIds.length > 0 || rawRows.length < input.chunkSize;
  const lastRow = rawRows.length > 0 ? rawRows[rawRows.length - 1] : null;
  const nextCursor = !done && lastRow ? parsePositiveIntegerOrNull(lastRow?.id) : null;

  return {
    status: input.status,
    cursor: input.cursor,
    nextCursor,
    chunkSize: input.chunkSize,
    done,
    stats,
  };
}

export async function GET(req: NextRequest) {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection failed" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const status = parseQueueStatusFilter(searchParams.get("status"), "pending");
    const batchId = searchParams.get("batch_id");
    const category = searchParams.get("category");
    const cjProductId = (searchParams.get("cj_product_id") || "").trim();
    const limit = clampInteger(searchParams.get("limit"), 1, 100, 50);
    const offset = clampInteger(searchParams.get("offset"), 0, 1_000_000, 0);

    let query = supabase.from('product_queue').select('*');
    
    if (status !== "all") {
      query = query.eq('status', status);
    }
    if (batchId) {
      query = query.eq('batch_id', Number(batchId));
    }
    if (category && category !== "all") {
      query = query.eq('category', category);
    }
    if (cjProductId) {
      query = query.eq('cj_product_id', cjProductId);
    }

    query = query.order('quality_score', { ascending: false })
                 .order('created_at', { ascending: false })
                 .range(offset, offset + limit - 1);

    const { data: products, error: queryError } = await query;

    if (queryError) {
      console.error("[Queue GET] Query error:", queryError);
      if (queryError.message.includes('does not exist')) {
        return NextResponse.json({ 
          ok: false, 
          error: "Import tables not found. Please run the database migration first." 
        }, { status: 500 });
      }
      return NextResponse.json({ ok: false, error: queryError.message }, { status: 500 });
    }

    let totalCountQuery = supabase
      .from('product_queue')
      .select('*', { count: 'exact', head: true });
    if (status !== "all") {
      totalCountQuery = totalCountQuery.eq('status', status);
    }
    if (batchId) {
      totalCountQuery = totalCountQuery.eq('batch_id', Number(batchId));
    }
    if (category && category !== "all") {
      totalCountQuery = totalCountQuery.eq('category', category);
    }
    if (cjProductId) {
      totalCountQuery = totalCountQuery.eq('cj_product_id', cjProductId);
    }
    const { count: totalCount } = await totalCountQuery;

    const [pendingRes, approvedRes, rejectedRes, importedRes] = await Promise.all([
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'imported'),
    ]);

    const stats = {
      pending: pendingRes.count || 0,
      approved: approvedRes.count || 0,
      rejected: rejectedRes.count || 0,
      imported: importedRes.count || 0,
    };

    const rawProducts = products || [];
    const initiallyNormalizedProducts = rawProducts.map((product: any) => normalizeQueueProductRow(product));
    const enrichedRawProducts = await enrichStaleQueueRows(req, supabase, rawProducts, initiallyNormalizedProducts);
    const normalizedProducts = enrichedRawProducts.map((product: any) => normalizeQueueProductRow(product));

    return NextResponse.json({
      ok: true,
      products: normalizedProducts,
      total: totalCount || 0,
      stats,
    });
  } catch (e: any) {
    console.error("[Queue GET] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection failed" }, { status: 500 });
    }

    const body = await req.json();
    const { ids, action, data } = body || {};

    if (action === "backfill") {
      const parsedIds = parseQueueIdArray(ids);
      const parsedStatus = parseQueueStatusFilter(body?.status, "all");
      const parsedCursor = parsePositiveIntegerOrNull(body?.cursor);
      const parsedChunkSize = clampInteger(body?.chunkSize, 1, 20, 6);
      const parsedConcurrency = clampInteger(body?.concurrency, 1, 6, 3);

      try {
        const result = await runQueueBackfillChunk(req, supabase, {
          status: parsedStatus,
          cursor: parsedCursor,
          chunkSize: parsedChunkSize,
          ids: parsedIds,
          concurrency: parsedConcurrency,
        });

        return NextResponse.json({
          ok: true,
          action: "backfill",
          status: result.status,
          cursor: result.cursor,
          nextCursor: result.nextCursor,
          chunkSize: result.chunkSize,
          done: result.done,
          scanned: result.stats.scannedRows,
          stale: result.stats.staleRows,
          updated: result.stats.mergedRows,
          persisted: result.stats.persistedRows,
          previewHits: result.stats.previewHits,
          previewMisses: result.stats.previewMisses,
          persistFailures: result.stats.persistFailures,
        });
      } catch (backfillError: any) {
        console.error("[Queue PATCH] Backfill error:", backfillError);
        return NextResponse.json(
          { ok: false, error: backfillError?.message || "Backfill failed" },
          { status: 500 }
        );
      }
    }

    const parsedIds = parseQueueIdArray(ids);
    if (parsedIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid product IDs provided" }, { status: 400 });
    }

    let updateData: Record<string, any> = { updated_at: new Date().toISOString() };

    switch (action) {
      case "approve":
        updateData.status = 'approved';
        updateData.reviewed_at = new Date().toISOString();
        break;
      case "reject":
        updateData.status = 'rejected';
        updateData.reviewed_at = new Date().toISOString();
        break;
      case "pending":
        updateData.status = 'pending';
        updateData.reviewed_at = null;
        break;
      case "update":
        if (data) {
          if (data.name_en) updateData.name_en = data.name_en;
          if (data.name_ar) updateData.name_ar = data.name_ar;
          if (data.description_en) updateData.description_en = data.description_en;
          if (data.description_ar) updateData.description_ar = data.description_ar;
          if (data.category) updateData.category = data.category;
          if (data.admin_notes !== undefined) updateData.admin_notes = data.admin_notes;
          if (data.calculated_retail_sar) updateData.calculated_retail_sar = data.calculated_retail_sar;
          if (data.margin_applied) updateData.margin_applied = data.margin_applied;
        }
        break;
      default:
        return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
    }

    const { error: updateError } = await supabase
      .from('product_queue')
      .update(updateData)
      .in('id', parsedIds);

    if (updateError) {
      console.error("[Queue PATCH] Update error:", updateError);
      return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
    }

    try {
      await supabase.from('import_logs').insert({
        action: `queue_${action}`,
        status: 'success',
        details: { ids: parsedIds, action, data }
      });
    } catch (logErr) {
      console.error("[Queue PATCH] Log error:", logErr);
    }

    return NextResponse.json({ ok: true, updated: parsedIds.length });
  } catch (e: any) {
    console.error("[Queue PATCH] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection failed" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids");

    if (!idsParam) {
      return NextResponse.json({ ok: false, error: "No IDs provided" }, { status: 400 });
    }

    const ids = idsParam.split(",").map(Number).filter(n => !isNaN(n));
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "Invalid IDs" }, { status: 400 });
    }

    const { error: deleteError } = await supabase
      .from('product_queue')
      .delete()
      .in('id', ids);

    if (deleteError) {
      console.error("[Queue DELETE] Delete error:", deleteError);
      return NextResponse.json({ ok: false, error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deleted: ids.length });
  } catch (e: any) {
    console.error("[Queue DELETE] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
