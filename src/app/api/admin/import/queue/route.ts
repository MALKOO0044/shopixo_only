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
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  }
  if (isNonEmptyString(parsed)) {
    if (!parsed.includes(",")) return [parsed.trim()];
    return parsed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
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
    const status = searchParams.get("status") || "pending";
    const batchId = searchParams.get("batch_id");
    const category = searchParams.get("category");
    const cjProductId = (searchParams.get("cj_product_id") || "").trim();
    const limit = Math.min(100, Number(searchParams.get("limit") || 50));
    const offset = Number(searchParams.get("offset") || 0);

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

    const normalizedProducts = (products || []).map((product: any) => {
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
          .map((variant: any) => (isNonEmptyString(variant?.color) ? variant.color.trim() : ""))
          .filter((value) => value.length > 0);
      }

      let availableSizes = parseQueueStringArray(product?.available_sizes);
      if (availableSizes.length === 0) {
        availableSizes = parsedVariants
          .map((variant: any) => (isNonEmptyString(variant?.size) ? variant.size.trim() : ""))
          .filter((value) => value.length > 0);
      }

      const displayName =
        [product?.name_en, product?.name, product?.title, product?.product_name]
          .find((value) => isNonEmptyString(value)) || `CJ Product ${String(product?.cj_product_id || "").slice(-10)}`;

      const displayCategory =
        [product?.category_name, product?.category]
          .find((value) => isNonEmptyString(value)) || "General";

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
    });

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
    const { ids, action, data } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No product IDs provided" }, { status: 400 });
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
      .in('id', ids);

    if (updateError) {
      console.error("[Queue PATCH] Update error:", updateError);
      return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
    }

    try {
      await supabase.from('import_logs').insert({
        action: `queue_${action}`,
        status: 'success',
        details: { ids, action, data }
      });
    } catch (logErr) {
      console.error("[Queue PATCH] Log error:", logErr);
    }

    return NextResponse.json({ ok: true, updated: ids.length });
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
