const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

export function normalizePagination(query = {}) {
  const page = toPositiveInteger(query.page, 1);
  const requestedPageSize = toPositiveInteger(query.pageSize, DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, requestedPageSize);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };
}

export function paginationMeta({ page, pageSize }, total) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / pageSize);
  return {
    page,
    pageSize,
    total: safeTotal,
    totalPages,
    hasPrev: page > 1 && safeTotal > 0,
    hasNext: page * pageSize < safeTotal
  };
}
