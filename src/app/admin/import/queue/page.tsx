"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  CheckCircle,
  XCircle,
  Clock,
  Package,
  Download,
  Edit,
  Trash2,
  Star,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Filter,
  Eye,
  Play,
} from "lucide-react";
import SmartImage from "@/components/smart-image";
import { enhanceProductImageUrl } from "@/lib/media/image-quality";
import { sarToUsd } from "@/lib/pricing";

type QueueProduct = {
  id: number;
  batch_id: number | null;
  cj_product_id: string;
  store_sku?: string | null;
  product_code?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  name?: string | null;
  category?: string | null;
  category_name?: string | null;
  display_name?: string | null;
  display_category?: string | null;
  images?: unknown;
  variants?: unknown;
  cj_price_usd?: number | null;
  shipping_cost_usd: number | null;
  calculated_retail_sar: number | null;
  profit_margin?: number | null;
  displayed_rating?: number | null;
  rating_confidence?: number | null;
  supplier_rating?: number | null;
  review_count?: number | null;
  stock_total?: number | null;
  quality_score: number;
  status: string;
  admin_notes: string | null;
  delivery_days_min: number;
  delivery_days_max: number;
  created_at: string;
  available_colors?: string[] | string | null;
  available_sizes?: string[] | string | null;
  variant_pricing?: any[] | string | null;
  video_url?: string | null;
  video_source_url?: string | null;
  video_4k_url?: string | null;
  video_delivery_mode?: 'native' | 'enhanced' | 'passthrough' | null;
  video_quality_gate_passed?: boolean | null;
  video_source_quality_hint?: '4k' | 'hd' | 'sd' | 'unknown' | null;
  media_mode?: string | null;
  has_video?: boolean | null;
};

function parseQueueJsonMaybe(value: unknown): unknown {
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

function parseQueueStringArray(value: unknown): string[] {
  const parsed = parseQueueJsonMaybe(value);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item: unknown): string => (typeof item === "string" ? item.trim() : ""))
      .filter((item: string) => item.length > 0);
  }
  if (typeof parsed === "string") {
    if (!parsed.includes(",")) return parsed.trim() ? [parsed.trim()] : [];
    return parsed
      .split(",")
      .map((item: string): string => item.trim())
      .filter((item: string) => item.length > 0);
  }
  return [];
}

function parseQueueVariants(value: QueueProduct["variants"]): any[] {
  const parsed = parseQueueJsonMaybe(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseQueueImages(value: QueueProduct["images"]): string[] {
  const parsed = parseQueueJsonMaybe(value);
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item));
  }
  if (typeof parsed === "string" && /^https?:\/\//i.test(parsed.trim())) {
    return [parsed.trim()];
  }
  return [];
}

function parseQueueVariantPricing(value: QueueProduct["variant_pricing"]): any[] {
  const parsed = parseQueueJsonMaybe(value);
  return Array.isArray(parsed) ? parsed : [];
}

const PLACEHOLDER_QUEUE_CATEGORY_TOKENS = new Set([
  "general",
  "uncategorized",
  "unknown",
  "misc",
  "others",
]);

function isPlaceholderQueueName(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (/^cj product\b/.test(normalized)) return true;
  if (/^unavailable cj product\b/.test(normalized)) return true;
  if (/^unknown product\b/.test(normalized)) return true;
  return false;
}

function isPlaceholderQueueCategory(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return PLACEHOLDER_QUEUE_CATEGORY_TOKENS.has(normalized);
}

function resolveQueueDisplayName(product: QueueProduct): string {
  const direct = [product.display_name, product.name_en, product.name]
    .find((value) => typeof value === "string" && value.trim().length > 0 && !isPlaceholderQueueName(value));
  if (direct) return direct.trim();
  const fallback = [product.display_name, product.name_en, product.name]
    .find((value) => typeof value === "string" && value.trim().length > 0);
  if (fallback) return fallback.trim();
  const suffix = String(product.cj_product_id || "").slice(-10);
  return suffix ? `CJ Product ${suffix}` : "CJ Product";
}

function resolveQueueDisplayCategory(product: QueueProduct): string {
  const direct = [product.display_category, product.category_name, product.category]
    .find((value) => typeof value === "string" && value.trim().length > 0 && !isPlaceholderQueueCategory(value));
  return direct ? direct.trim() : "General";
}

function resolveQueueImages(product: QueueProduct): string[] {
  const direct = parseQueueImages(product.images);
  if (direct.length > 0) return direct;

  const variants = parseQueueVariants(product.variants);
  const fromVariants = variants
    .map((variant) => variant?.variantImage || variant?.colorImage || variant?.image)
    .filter((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value));
  return fromVariants;
}

function resolveQueueDisplayPriceUsd(product: QueueProduct): number | null {
  const variantPricing = parseQueueVariantPricing(product.variant_pricing);
  const directUsdPrices = variantPricing
    .map((v: any) => Number(v?.priceUsd ?? v?.sellPriceUSD ?? v?.sellPriceUsd))
    .filter((p: number) => Number.isFinite(p) && p > 0);

  if (directUsdPrices.length > 0) {
    return Math.min(...directUsdPrices);
  }

  const directRetailSar = Number(product.calculated_retail_sar);
  if (Number.isFinite(directRetailSar) && directRetailSar > 0) {
    return sarToUsd(directRetailSar);
  }

  const variantRetailPrices = variantPricing
    .map((v: any) => Number(v?.price ?? v?.sellPriceSAR ?? v?.sellPriceSar))
    .filter((p: number) => Number.isFinite(p) && p > 0);

  if (variantRetailPrices.length > 0) {
    return sarToUsd(Math.min(...variantRetailPrices));
  }

  const variantCostPrices = parseQueueVariants(product.variants)
    .map((v: any) => Number(v?.variantPriceUSD ?? v?.variantPrice ?? v?.costPrice ?? v?.price))
    .filter((p: number) => Number.isFinite(p) && p > 0);
  if (variantCostPrices.length > 0) {
    return Math.min(...variantCostPrices);
  }

  return null;
}

function resolveQueueBaseCostUsd(product: QueueProduct): number {
  const direct = Number(product.cj_price_usd);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const variantPricing = parseQueueVariantPricing(product.variant_pricing);
  const pricingCandidates = variantPricing
    .map((v: any) => Number(v?.costPrice ?? v?.variantPriceUSD ?? v?.variantPrice ?? v?.cost))
    .filter((p: number) => Number.isFinite(p) && p > 0);
  if (pricingCandidates.length > 0) return Math.min(...pricingCandidates);

  const variantCandidates = parseQueueVariants(product.variants)
    .map((v: any) => Number(v?.variantPriceUSD ?? v?.variantPrice ?? v?.costPrice ?? v?.price))
    .filter((p: number) => Number.isFinite(p) && p > 0);
  if (variantCandidates.length > 0) return Math.min(...variantCandidates);

  return 0;
}

function resolveQueueStockTotal(product: QueueProduct): number {
  const direct = Number(product.stock_total);
  if (Number.isFinite(direct) && direct >= 0) return Math.floor(direct);

  const fromVariants = parseQueueVariants(product.variants)
    .map((v: any) =>
      Number(v?.stock ?? v?.totalStock ?? (Number(v?.cjStock || 0) + Number(v?.factoryStock || 0)))
    )
    .filter((value: number) => Number.isFinite(value) && value >= 0);

  if (fromVariants.length === 0) return 0;
  return Math.floor(fromVariants.reduce((sum, value) => sum + value, 0));
}

function resolveQueueMarginPercent(product: QueueProduct): number | null {
  const directMargin = Number(product.profit_margin);
  if (Number.isFinite(directMargin) && directMargin > 0) return directMargin;

  const variantPricing = parseQueueVariantPricing(product.variant_pricing);
  const margins = variantPricing
    .map((v: any) => Number(v?.marginPercent ?? v?.profitMargin ?? v?.margin))
    .filter((m: number) => Number.isFinite(m) && m > 0);

  if (margins.length === 0) return null;
  return Number((margins.reduce((sum, m) => sum + m, 0) / margins.length).toFixed(1));
}

function resolveQueueStoreSku(product: QueueProduct): string {
  const storeSku = typeof product.store_sku === "string" ? product.store_sku.trim() : "";
  if (storeSku) return storeSku;

  const productCode = typeof product.product_code === "string" ? product.product_code.trim() : "";
  if (productCode) return productCode;

  return product.cj_product_id || "-";
}

function hasQueueVideo(product: QueueProduct): boolean {
  const primary = typeof product.video_4k_url === "string" ? product.video_4k_url.trim() : "";
  const fallback = typeof product.video_url === "string" ? product.video_url.trim() : "";
  return primary.length > 0 || fallback.length > 0 || product.has_video === true;
}

function getQueueVideoUrl(product: QueueProduct): string | null {
  const primary = typeof product.video_4k_url === "string" ? product.video_4k_url.trim() : "";
  if (primary) return primary;

  const fallback = typeof product.video_url === "string" ? product.video_url.trim() : "";
  return fallback || null;
}

function resolveQueueDisplayedRating(product: QueueProduct): number {
  const displayedRatingRaw = Number(product.displayed_rating);
  if (Number.isFinite(displayedRatingRaw) && displayedRatingRaw > 0) {
    return Math.min(5, Math.max(0, displayedRatingRaw));
  }

  const supplierRatingRaw = Number(product.supplier_rating);
  if (Number.isFinite(supplierRatingRaw) && supplierRatingRaw > 0) {
    return Math.min(5, Math.max(0, supplierRatingRaw));
  }

  return 0;
}

function normalizeQueueReviewCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.floor(numeric));
}

function resolveQueueReviewCount(product: QueueProduct): number {
  return normalizeQueueReviewCount(product.review_count);
}

type Stats = {
  pending: number;
  approved: number;
  rejected: number;
  imported: number;
};

type QueueBackfillProgress = {
  running: boolean;
  done: boolean;
  scanned: number;
  stale: number;
  liveHits: number;
  snapshotHitsSkipped: number;
  blockedUnavailable: number;
  updated: number;
  persisted: number;
  previewMisses: number;
  persistFailures: number;
  reasonCounts: Record<string, number>;
  cursor: number | null;
  error: string | null;
};

function normalizeBackfillReasonCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, number> = {};
  for (const [key, raw] of entries) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    const parsedValue = Number(raw);
    if (!normalizedKey || !Number.isFinite(parsedValue) || parsedValue <= 0) continue;
    output[normalizedKey] = Math.floor(parsedValue);
  }
  return output;
}

function mergeBackfillReasonCounts(
  baseCounts: Record<string, number>,
  incomingCounts: Record<string, number>
): Record<string, number> {
  if (Object.keys(incomingCounts).length === 0) return baseCounts;
  const merged: Record<string, number> = { ...baseCounts };
  for (const [reason, count] of Object.entries(incomingCounts)) {
    merged[reason] = (merged[reason] || 0) + count;
  }
  return merged;
}

function formatBackfillReasonLabel(reason: string): string {
  return reason.replace(/_/g, " ");
}

type SchemaRemediation = {
  ready: boolean;
  missingColumns: string[];
  missingColumnsByTable?: {
    product_queue?: string[];
    products?: string[];
  };
  migrationSQL: string | null;
  instructions: string[];
};

type LocalCategory = {
  id: number;
  name: string;
  slug: string;
  level: number;
  parentId: number | null;
  parentName: string | null;
  children?: LocalCategory[];
};

const statusColors: Record<string, { bg: string; text: string; icon: any }> = {
  pending: { bg: "bg-amber-100", text: "text-amber-800", icon: Clock },
  approved: { bg: "bg-green-100", text: "text-green-800", icon: CheckCircle },
  rejected: { bg: "bg-red-100", text: "text-red-800", icon: XCircle },
  imported: { bg: "bg-blue-100", text: "text-blue-800", icon: Package },
};

export default function QueuePage() {
  const [products, setProducts] = useState<QueueProduct[]>([]);
  const [stats, setStats] = useState<Stats>({ pending: 0, approved: 0, rejected: 0, imported: 0 });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [schemaRemediation, setSchemaRemediation] = useState<SchemaRemediation | null>(null);
  const [copiedMigrationSql, setCopiedMigrationSql] = useState(false);
  const [localCategories, setLocalCategories] = useState<LocalCategory[]>([]);
  
  const [statusFilter, setStatusFilter] = useState("pending");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [page, setPage] = useState(0);
  const limit = 20;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionLoading, setActionLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Partial<QueueProduct>>({});
  const [backfillProgress, setBackfillProgress] = useState<QueueBackfillProgress>({
    running: false,
    done: false,
    scanned: 0,
    stale: 0,
    liveHits: 0,
    snapshotHitsSkipped: 0,
    blockedUnavailable: 0,
    updated: 0,
    persisted: 0,
    previewMisses: 0,
    persistFailures: 0,
    reasonCounts: {},
    cursor: null,
    error: null,
  });
  const backfillInFlightRef = useRef(false);
  const backfillDoneRef = useRef(false);
  const backfillCursorRef = useRef<number | null>(null);
  const backfillTimerRef = useRef<number | null>(null);
  const backfillErrorCountRef = useRef(0);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        category: categoryFilter,
        limit: limit.toString(),
        offset: (page * limit).toString(),
      });
      
      const res = await fetch(`/api/admin/import/queue?${params}`);
      const data = await res.json();
      
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to fetch queue");
      }
      
      setProducts(data.products || []);
      setTotal(data.total || 0);
      setStats(data.stats || { pending: 0, approved: 0, rejected: 0, imported: 0 });
    } catch (e: any) {
      setError(e?.message || "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, page]);

  const runGlobalQueueBackfill = useCallback(async () => {
    if (backfillInFlightRef.current || backfillDoneRef.current) return;

    let shouldRefreshProducts = false;
    backfillInFlightRef.current = true;
    setBackfillProgress((prev) => ({ ...prev, running: true, error: null }));

    try {
      let loops = 0;
      while (loops < 8 && !backfillDoneRef.current) {
        const res = await fetch("/api/admin/import/queue", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "backfill",
            status: "all",
            cursor: backfillCursorRef.current,
            chunkSize: 6,
            concurrency: 3,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || "Queue backfill request failed");
        }

        const nextCursor = typeof data.nextCursor === "number" ? data.nextCursor : null;
        const done = Boolean(data.done);
        const scanned = Number.isFinite(Number(data.scanned)) ? Number(data.scanned) : 0;
        const stale = Number.isFinite(Number(data.stale)) ? Number(data.stale) : 0;
        const liveHits = Number.isFinite(Number(data.liveHits)) ? Number(data.liveHits) : 0;
        const snapshotHitsSkipped = Number.isFinite(Number(data.snapshotHitsSkipped)) ? Number(data.snapshotHitsSkipped) : 0;
        const blockedUnavailable = Number.isFinite(Number(data.blockedUnavailable)) ? Number(data.blockedUnavailable) : 0;
        const updated = Number.isFinite(Number(data.updated)) ? Number(data.updated) : 0;
        const persisted = Number.isFinite(Number(data.persisted)) ? Number(data.persisted) : 0;
        const previewMisses = Number.isFinite(Number(data.previewMisses)) ? Number(data.previewMisses) : 0;
        const persistFailures = Number.isFinite(Number(data.persistFailures)) ? Number(data.persistFailures) : 0;
        const reasonCounts = normalizeBackfillReasonCounts(data.reasonCounts);

        if (updated > 0 || persisted > 0) {
          shouldRefreshProducts = true;
        }

        backfillCursorRef.current = nextCursor;
        backfillDoneRef.current = done;
        backfillErrorCountRef.current = 0;

        setBackfillProgress((prev) => ({
          ...prev,
          running: true,
          done,
          cursor: nextCursor,
          scanned: prev.scanned + scanned,
          stale: prev.stale + stale,
          liveHits: prev.liveHits + liveHits,
          snapshotHitsSkipped: prev.snapshotHitsSkipped + snapshotHitsSkipped,
          blockedUnavailable: prev.blockedUnavailable + blockedUnavailable,
          updated: prev.updated + updated,
          persisted: prev.persisted + persisted,
          previewMisses: prev.previewMisses + previewMisses,
          persistFailures: prev.persistFailures + persistFailures,
          reasonCounts: mergeBackfillReasonCounts(prev.reasonCounts, reasonCounts),
          error: null,
        }));

        loops += 1;
        if (done) break;
      }
    } catch (e: any) {
      backfillErrorCountRef.current += 1;
      setBackfillProgress((prev) => ({
        ...prev,
        error: e?.message || "Queue backfill failed",
      }));
    } finally {
      backfillInFlightRef.current = false;
      setBackfillProgress((prev) => ({
        ...prev,
        running: false,
        done: backfillDoneRef.current || prev.done,
      }));

      if (shouldRefreshProducts) {
        fetchProducts();
      }

      if (!backfillDoneRef.current && backfillErrorCountRef.current < 3) {
        if (backfillTimerRef.current != null) {
          window.clearTimeout(backfillTimerRef.current);
        }
        backfillTimerRef.current = window.setTimeout(() => {
          backfillTimerRef.current = null;
          void runGlobalQueueBackfill();
        }, 700);
      }
    }
  }, [fetchProducts]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    if (backfillDoneRef.current || backfillInFlightRef.current) return;
    if (backfillTimerRef.current != null) return;

    backfillTimerRef.current = window.setTimeout(() => {
      backfillTimerRef.current = null;
      void runGlobalQueueBackfill();
    }, 300);

    return () => {
      if (backfillTimerRef.current != null) {
        window.clearTimeout(backfillTimerRef.current);
        backfillTimerRef.current = null;
      }
    };
  }, [runGlobalQueueBackfill]);

  useEffect(() => {
    async function fetchLocalCategories() {
      try {
        const res = await fetch("/api/admin/categories/map");
        const data = await res.json();
        if (data.ok && data.categories) {
          setLocalCategories(data.categories);
        }
      } catch (e) {
        console.error("Failed to fetch local categories:", e);
      }
    }
    fetchLocalCategories();
  }, []);

  const loadSchemaRemediation = useCallback(async (): Promise<SchemaRemediation | null> => {
    try {
      const res = await fetch("/api/admin/migrate/product-queue", { method: "GET" });
      const data = await res.json();

      if (!res.ok || !data || typeof data !== "object") return null;

      const missingColumns = Array.isArray(data.missingColumns)
        ? data.missingColumns.map((col: unknown) => String(col))
        : [];

      const missingByTableRaw = data.missingColumnsByTable;
      const missingColumnsByTable: SchemaRemediation["missingColumnsByTable"] =
        missingByTableRaw && typeof missingByTableRaw === "object"
          ? {
              product_queue: Array.isArray((missingByTableRaw as Record<string, unknown>).product_queue)
                ? ((missingByTableRaw as Record<string, unknown>).product_queue as unknown[]).map((col) => String(col))
                : [],
              products: Array.isArray((missingByTableRaw as Record<string, unknown>).products)
                ? ((missingByTableRaw as Record<string, unknown>).products as unknown[]).map((col) => String(col))
                : [],
            }
          : undefined;

      const instructions = Array.isArray(data.instructions)
        ? data.instructions.map((step: unknown) => String(step))
        : [];

      const remediation: SchemaRemediation = {
        ready: Boolean(data.ready),
        missingColumns,
        missingColumnsByTable,
        migrationSQL: typeof data.migrationSQL === "string" && data.migrationSQL.trim().length > 0
          ? data.migrationSQL
          : null,
        instructions,
      };

      if (remediation.ready || remediation.missingColumns.length === 0) {
        setSchemaRemediation(null);
        return null;
      }

      setSchemaRemediation(remediation);
      return remediation;
    } catch (schemaError) {
      console.error("Failed to load schema remediation:", schemaError);
      return null;
    }
  }, []);

  const copyMigrationSql = useCallback(async () => {
    const sql = schemaRemediation?.migrationSQL;
    if (!sql) return;
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedMigrationSql(true);
      setTimeout(() => setCopiedMigrationSql(false), 2000);
    } catch {
      setError("Unable to copy migration SQL automatically. Please copy it manually.");
    }
  }, [schemaRemediation]);

  const toggleSelect = (id: number) => {
    setSelected((prev: Set<number>) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(products.map((p: QueueProduct) => p.id)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  const handleBulkAction = async (action: string) => {
    if (selected.size === 0) return;
    
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/import/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), action }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Action failed");
      }
      
      setSelected(new Set());
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const handleImport = async () => {
    const approvedIds = products
      .filter((p: QueueProduct) => p.status === "approved" && selected.has(p.id))
      .map((p: QueueProduct) => p.id);
    if (approvedIds.length === 0) {
      setError("Select approved products to import");
      return;
    }
    
    if (!confirm(`Import ${approvedIds.length} products to your store?`)) return;
    
    setActionLoading(true);
    setCopiedMigrationSql(false);
    setSchemaRemediation(null);
    try {
      const res = await fetch("/api/admin/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: approvedIds }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const errorMessage = String(data?.error || "Import failed");
        const missingColumns = Array.isArray(data?.missingColumns) ? data.missingColumns : [];
        const isSchemaFidelityError =
          missingColumns.length > 0 ||
          /missing required fidelity columns|please run latest supabase migrations/i.test(errorMessage);

        if (isSchemaFidelityError) {
          await loadSchemaRemediation();
        }

        throw new Error(errorMessage);
      }

      const importedCount = Number(data?.imported ?? 0);
      if (!Number.isFinite(importedCount) || importedCount <= 0) {
        const firstFailure = Array.isArray(data?.results)
          ? data.results.find((result: any) => result && result.success === false)
          : null;
        const firstFailureMessage = typeof firstFailure?.error === "string" ? firstFailure.error : "";
        throw new Error(firstFailureMessage || String(data?.error || "Import finished with zero imported products."));
      }
      
      setSelected(new Set());
      setSchemaRemediation(null);
      fetchProducts();
      alert(`Successfully imported ${importedCount} products!`);
    } catch (e: any) {
      setError(e?.message || "Import failed");
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    
    if (!confirm(`Delete ${selected.size} products from the queue? This cannot be undone.`)) return;
    
    setActionLoading(true);
    try {
      const ids = Array.from(selected).join(",");
      const res = await fetch(`/api/admin/import/queue?ids=${ids}`, {
        method: "DELETE",
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Delete failed");
      }
      
      setSelected(new Set());
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Delete failed");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSingleAction = async (id: number, action: string) => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/import/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id], action }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Action failed");
      }
      
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const startEdit = (product: QueueProduct) => {
    setEditingId(product.id);
    setEditData({
      name_en: resolveQueueDisplayName(product),
      name_ar: product.name_ar || "",
      category: resolveQueueDisplayCategory(product),
      admin_notes: product.admin_notes || "",
    });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/import/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [editingId], action: "update", data: editData }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Update failed");
      }
      
      setEditingId(null);
      setEditData({});
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Update failed");
    } finally {
      setActionLoading(false);
    }
  };

  const exportCsv = () => {
    const headers = [
      "ID",
      "Store SKU",
      "CJ Product ID",
      "Name",
      "Category",
      "Retail USD",
      "Cost USD",
      "Margin %",
      "Stock",
      "Displayed Rating",
      "Reviewed Count",
      "Status",
      "Created",
    ];
    const rows = products.map((p: QueueProduct) => [
      p.id,
      resolveQueueStoreSku(p),
      p.cj_product_id,
      `"${resolveQueueDisplayName(p).replace(/"/g, '""')}"`,
      resolveQueueDisplayCategory(p),
      resolveQueueDisplayPriceUsd(p)?.toFixed(2) ?? "",
      resolveQueueBaseCostUsd(p).toFixed(2),
      resolveQueueMarginPercent(p)?.toFixed(1) ?? "",
      resolveQueueStockTotal(p),
      resolveQueueDisplayedRating(p).toFixed(1),
      resolveQueueReviewCount(p),
      p.status,
      new Date(p.created_at).toLocaleDateString(),
    ]);
    
    const csv = [headers.join(","), ...rows.map((r: Array<string | number | null>) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `queue-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / limit);
  const backfillReasonEntries = Object.entries(backfillProgress.reasonCounts)
    .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Import Queue</h1>
          <p className="text-sm text-gray-500 mt-1">قائمة انتظار الاستيراد - Review and approve products</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={exportCsv}
            className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
          <Link
            href="/admin/import/discover"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            Discover Products
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {Object.entries(stats).map(([status, count]) => {
          const colors = statusColors[status] || statusColors.pending;
          const Icon = colors.icon;
          return (
            <button
              key={status}
              onClick={() => { setStatusFilter(status); setPage(0); }}
              className={`p-4 rounded-xl border-2 transition-all ${
                statusFilter === status ? "border-gray-900 bg-gray-50" : "border-gray-100 hover:border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className={`w-10 h-10 rounded-lg ${colors.bg} flex items-center justify-center`}>
                  <Icon className={`h-5 w-5 ${colors.text}`} />
                </div>
                <span className="text-2xl font-bold text-gray-900">{count}</span>
              </div>
              <p className="mt-2 text-sm text-gray-600 capitalize">{status}</p>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border shadow-sm p-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">Filter by Category:</span>
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value); setPage(0); }}
            className="flex-1 max-w-md px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="all">All Categories</option>
            {localCategories
              .filter(c => c.level === 1)
              .map(mainCat => (
                <optgroup key={mainCat.id} label={mainCat.name}>
                  <option value={mainCat.slug}>All {mainCat.name}</option>
                  {localCategories
                    .filter(c => c.level === 2 && c.parentId === mainCat.id)
                    .flatMap(subCat => [
                      <option key={`sub-${subCat.id}`} value={subCat.slug}>
                        {subCat.name}
                      </option>,
                      ...localCategories
                        .filter(c => c.level === 3 && c.parentId === subCat.id)
                        .map(leaf => (
                          <option key={`leaf-${leaf.id}`} value={leaf.slug}>
                            &nbsp;&nbsp;↳ {leaf.name}
                          </option>
                        ))
                    ])}
                </optgroup>
              ))}
          </select>
          {categoryFilter !== "all" && (
            <button
              onClick={() => { setCategoryFilter("all"); setPage(0); }}
              className="text-sm text-blue-600 hover:underline"
            >
              Clear filter
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">
            Queue preview sync: {backfillProgress.done ? "completed" : backfillProgress.running ? "running" : "in progress"}
          </span>
          {!backfillProgress.done && !backfillProgress.running && (
            <button
              onClick={() => void runGlobalQueueBackfill()}
              className="px-2 py-1 border border-blue-300 rounded bg-white hover:bg-blue-100 text-blue-800"
            >
              Resume
            </button>
          )}
        </div>
        <p className="mt-1">
          Scanned: {backfillProgress.scanned.toLocaleString()} · Stale: {backfillProgress.stale.toLocaleString()} · Updated: {backfillProgress.updated.toLocaleString()} · Persisted: {backfillProgress.persisted.toLocaleString()}
        </p>
        {(backfillProgress.liveHits > 0 || backfillProgress.snapshotHitsSkipped > 0 || backfillProgress.blockedUnavailable > 0) && (
          <p className="mt-1 text-blue-800">
            Live hits: {backfillProgress.liveHits.toLocaleString()} · Snapshot skipped: {backfillProgress.snapshotHitsSkipped.toLocaleString()} · Blocked unavailable: {backfillProgress.blockedUnavailable.toLocaleString()}
          </p>
        )}
        {(backfillProgress.previewMisses > 0 || backfillProgress.persistFailures > 0) && (
          <p className="mt-1 text-blue-800">
            Preview misses: {backfillProgress.previewMisses.toLocaleString()} · Persist failures: {backfillProgress.persistFailures.toLocaleString()}
          </p>
        )}
        {backfillReasonEntries.length > 0 && (
          <p className="mt-1 text-blue-800">
            Reasons: {backfillReasonEntries.map(([reason, count]) => `${formatBackfillReasonLabel(reason)}: ${Number(count).toLocaleString()}`).join(" · ")}
          </p>
        )}
        {backfillProgress.error && (
          <p className="mt-1 text-red-700">{backfillProgress.error}</p>
        )}
      </div>

      {schemaRemediation && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-amber-900">Database schema update required before import</p>
              <p className="text-xs text-amber-800 mt-1">
                Missing fidelity columns are blocking imports. Run the SQL below in Supabase SQL Editor,
                then reload schema.
              </p>
            </div>
            <button
              onClick={loadSchemaRemediation}
              className="text-xs px-2.5 py-1 border border-amber-400 text-amber-900 rounded hover:bg-amber-100"
            >
              Recheck
            </button>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded border border-amber-200 bg-white p-2">
              <p className="text-xs font-medium text-gray-700">product_queue missing columns</p>
              <p className="text-xs text-gray-600 mt-1">
                {schemaRemediation.missingColumnsByTable?.product_queue?.length
                  ? schemaRemediation.missingColumnsByTable.product_queue.join(", ")
                  : "None"}
              </p>
            </div>
            <div className="rounded border border-amber-200 bg-white p-2">
              <p className="text-xs font-medium text-gray-700">products missing columns</p>
              <p className="text-xs text-gray-600 mt-1">
                {schemaRemediation.missingColumnsByTable?.products?.length
                  ? schemaRemediation.missingColumnsByTable.products.join(", ")
                  : "None"}
              </p>
            </div>
          </div>

          {schemaRemediation.instructions.length > 0 && (
            <ol className="list-decimal list-inside space-y-1 text-xs text-amber-900">
              {schemaRemediation.instructions.map((step: string, index: number) => (
                <li key={`${step}-${index}`}>{step}</li>
              ))}
            </ol>
          )}

          {schemaRemediation.migrationSQL && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-gray-700">Migration SQL</p>
                <button
                  onClick={copyMigrationSql}
                  className="text-xs px-2.5 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50"
                >
                  {copiedMigrationSql ? "Copied" : "Copy SQL"}
                </button>
              </div>
              <textarea
                readOnly
                value={schemaRemediation.migrationSQL}
                className="w-full min-h-[130px] resize-y rounded border border-amber-200 bg-white p-2 font-mono text-xs text-gray-800"
              />
            </div>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
          <span className="text-blue-800 font-medium">{selected.size} products selected</span>
          <div className="flex items-center gap-2">
            {statusFilter === "pending" && (
              <>
                <button
                  onClick={() => handleBulkAction("approve")}
                  disabled={actionLoading}
                  className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
                >
                  <CheckCircle className="h-4 w-4" />
                  Approve All
                </button>
                <button
                  onClick={() => handleBulkAction("reject")}
                  disabled={actionLoading}
                  className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  Reject All
                </button>
              </>
            )}
            {statusFilter === "approved" && (
              <button
                onClick={handleImport}
                disabled={actionLoading}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                <Package className="h-4 w-4" />
                Import to Store
              </button>
            )}
            <button
              onClick={handleBulkDelete}
              disabled={actionLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-600 text-white rounded text-sm hover:bg-gray-700 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete Selected
            </button>
            <button onClick={deselectAll} className="text-sm text-gray-500 hover:underline ml-2">
              Clear Selection
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={selectAll} className="text-sm text-blue-600 hover:underline">Select All</button>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-500">
              Showing {products.length} of {total} products
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm text-gray-600">
              Page {page + 1} of {totalPages || 1}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-gray-500">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3" />
            Loading...
          </div>
        ) : products.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No products in queue</p>
            <Link href="/admin/import/discover" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
              Discover products to import
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="w-10 px-4 py-3"></th>
                <th className="w-20 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Image</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Variants</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rating</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="w-32 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((product) => {
                const isSelected = selected.has(product.id);
                const colors = statusColors[product.status] || statusColors.pending;
                const StatusIcon = colors.icon;
                const displayRetailUsd = resolveQueueDisplayPriceUsd(product);
                const displayMarginPercent = resolveQueueMarginPercent(product);
                const displayStoreSku = resolveQueueStoreSku(product);
                const queueVideoUrl = getQueueVideoUrl(product);
                const displayName = resolveQueueDisplayName(product);
                const displayCategory = resolveQueueDisplayCategory(product);
                const displayImages = resolveQueueImages(product);
                const displayBaseCostUsd = resolveQueueBaseCostUsd(product);
                const displayStockTotal = resolveQueueStockTotal(product);
                const displayColors = parseQueueStringArray(product.available_colors);
                const displaySizes = parseQueueStringArray(product.available_sizes);
                const displayVariants = parseQueueVariants(product.variants);

                return editingId === product.id ? (
                  <tr key={product.id} className="bg-blue-50">
                    <td colSpan={10} className="px-4 py-4">
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">English Name</label>
                            <input
                              type="text"
                              value={editData.name_en || ""}
                              onChange={(e) => setEditData(d => ({ ...d, name_en: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Arabic Name</label>
                            <input
                              type="text"
                              value={editData.name_ar || ""}
                              onChange={(e) => setEditData(d => ({ ...d, name_ar: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                              dir="rtl"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
                            <select
                              value={editData.category || ""}
                              onChange={(e) => setEditData(d => ({ ...d, category: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                            >
                              <option value="">Select Category</option>
                              {localCategories
                                .filter(c => c.level === 1)
                                .map(mainCat => (
                                  <optgroup key={mainCat.id} label={mainCat.name}>
                                    {localCategories
                                      .filter(c => c.level === 2 && c.parentId === mainCat.id)
                                      .flatMap(subCat => [
                                        <option key={`sub-${subCat.id}`} value={subCat.name}>
                                          {subCat.name}
                                        </option>,
                                        ...localCategories
                                          .filter(c => c.level === 3 && c.parentId === subCat.id)
                                          .map(leaf => (
                                            <option key={`leaf-${leaf.id}`} value={leaf.name}>
                                              ↳ {leaf.name}
                                            </option>
                                          ))
                                      ])}
                                  </optgroup>
                                ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Admin Notes</label>
                            <input
                              type="text"
                              value={editData.admin_notes || ""}
                              onChange={(e) => setEditData(d => ({ ...d, admin_notes: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={saveEdit}
                            disabled={actionLoading}
                            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                          >
                            Save Changes
                          </button>
                          <button
                            onClick={() => { setEditingId(null); setEditData({}); }}
                            className="px-4 py-2 border rounded text-sm hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={product.id} className={isSelected ? "bg-blue-50" : "hover:bg-gray-50"}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(product.id)}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="relative w-14 h-14 rounded-lg overflow-hidden bg-gray-100">
                        {displayImages[0] ? (
                          <SmartImage
                            src={enhanceProductImageUrl(displayImages[0], "card")}
                            alt={displayName}
                            fill
                            quality={95}
                            sizes="56px"
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            <Package className="h-6 w-6" />
                          </div>
                        )}

                        {queueVideoUrl && (
                          <a
                            href={queueVideoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="absolute bottom-1 left-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white"
                            title="Open product video"
                          >
                            <Play className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 line-clamp-2">{displayName}</p>
                      {hasQueueVideo(product) && (
                        <div className="space-y-0.5">
                          <span className="inline-flex items-center gap-1 text-[11px] text-blue-700">
                            <Play className="h-3 w-3" />
                            {product.video_4k_url ? '4K video ready' : 'Video available'}
                          </span>
                          {product.video_delivery_mode && (
                            <span className="block text-[10px] text-gray-500">
                              Delivery mode: {product.video_delivery_mode}
                              {product.video_source_quality_hint ? ` · Source hint: ${product.video_source_quality_hint.toUpperCase()}` : ''}
                              {typeof product.video_quality_gate_passed === 'boolean'
                                ? ` · Gate: ${product.video_quality_gate_passed ? 'passed' : 'failed'}`
                                : ''}
                            </span>
                          )}
                        </div>
                      )}
                      <span className="block font-mono text-xs text-emerald-700" title={displayStoreSku}>
                        Store SKU: {displayStoreSku}
                      </span>
                      <span className="font-mono text-xs text-blue-600" title={product.cj_product_id}>
                        CJ PID: {product.cj_product_id.length > 12 ? `...${product.cj_product_id.slice(-8)}` : product.cj_product_id}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 bg-gray-100 rounded text-xs text-gray-700">{displayCategory}</span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-green-600">
                        {displayRetailUsd !== null ? `$${displayRetailUsd.toFixed(2)} USD` : "$-"}
                      </p>
                      <p className="text-xs text-gray-500">Base Cost: ${displayBaseCostUsd.toFixed(2)}</p>
                      {displayMarginPercent !== null && (
                        <p className="text-xs text-emerald-600">Margin: {displayMarginPercent.toFixed(1)}%</p>
                      )}
                      <p className="text-xs text-gray-500">Stock: {displayStockTotal}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        {displayColors.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-xs text-gray-500">Colors:</span>
                            <span className="text-xs font-medium text-gray-700">{displayColors.length}</span>
                            <span className="text-xs text-gray-400 truncate max-w-[120px]" title={displayColors.join(', ')}>
                              ({displayColors.slice(0, 3).join(', ')}{displayColors.length > 3 ? '...' : ''})
                            </span>
                          </div>
                        )}
                        {displaySizes.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-xs text-gray-500">Sizes:</span>
                            <span className="text-xs font-medium text-gray-700">{displaySizes.length}</span>
                            <span className="text-xs text-gray-400 truncate max-w-[120px]" title={displaySizes.join(', ')}>
                              ({displaySizes.slice(0, 4).join(', ')}{displaySizes.length > 4 ? '...' : ''})
                            </span>
                          </div>
                        )}
                        {displayColors.length === 0 && displaySizes.length === 0 && (
                          <span className="text-xs text-gray-400">{displayVariants.length || 0} variants</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        {(() => {
                          const rating = resolveQueueDisplayedRating(product);
                          const reviewedCount = resolveQueueReviewCount(product);
                          const confidence =
                            typeof product.rating_confidence === "number"
                              ? product.rating_confidence >= 0.75
                                ? "high"
                                : product.rating_confidence >= 0.4
                                  ? "medium"
                                  : "low"
                              : "unknown";

                          return (
                            <>
                        <div className="flex items-center gap-1">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <Star
                              key={star}
                              className={`h-3 w-3 ${
                                star <= Math.round(rating)
                                  ? "fill-amber-400 text-amber-400"
                                  : "text-gray-300"
                              }`}
                            />
                          ))}
                          <span className="text-xs font-medium ml-1">{rating.toFixed(1)}</span>
                        </div>
                        <p className="text-xs text-gray-500">{reviewedCount.toLocaleString()} reviewed</p>
                        <p className="text-xs text-gray-500">{confidence} confidence</p>
                            </>
                          );
                        })()}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${colors.bg} ${colors.text}`}>
                        <StatusIcon className="h-3 w-3" />
                        {product.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {product.status === "pending" && (
                          <>
                            <button
                              onClick={() => handleSingleAction(product.id, "approve")}
                              disabled={actionLoading}
                              className="p-1.5 text-green-600 hover:bg-green-50 rounded"
                              title="Approve"
                            >
                              <CheckCircle className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleSingleAction(product.id, "reject")}
                              disabled={actionLoading}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                              title="Reject"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => startEdit(product)}
                          className="p-1.5 text-gray-600 hover:bg-gray-100 rounded"
                          title="Edit"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        <Link
                          href={`/admin/cj/product/${product.cj_product_id}`}
                          className="p-1.5 text-gray-600 hover:bg-gray-100 rounded"
                          title="View Details"
                        >
                          <Eye className="h-4 w-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
