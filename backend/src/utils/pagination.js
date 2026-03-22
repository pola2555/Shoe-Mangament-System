/**
 * Pagination helper.
 * Extracts page/limit from query params and returns offset + metadata.
 * 
 * Usage in controller:
 *   const { page, limit, offset } = parsePagination(req.query);
 *   const { data, total } = await service.list({ limit, offset });
 *   res.json(paginateResponse(data, total, page, limit));
 */

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function paginateResponse(data, total, page, limit) {
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

module.exports = { parsePagination, paginateResponse };
