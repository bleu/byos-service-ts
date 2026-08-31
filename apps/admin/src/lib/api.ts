const ADMIN_API_URL = process.env.ADMIN_API_URL ?? "http://localhost:9587";

async function apiFetch(path: string) {
  const res = await fetch(`${ADMIN_API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Admin API error: ${res.status} ${path}`);
  }
  return res.json();
}

export type TimeRange = "24h" | "7d" | "30d";

export async function getOverview(range: TimeRange = "24h") {
  return apiFetch(`/overview?range=${range}`);
}

export async function getSubsolvers(range: TimeRange = "24h") {
  return apiFetch(`/subsolvers?range=${range}`);
}

export async function getProposals(params: {
  subSolver?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params.subSolver) qs.set("subSolver", params.subSolver);
  if (params.status) qs.set("status", params.status);
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  return apiFetch(`/proposals?${qs}`);
}

export async function getProposal(id: number) {
  return apiFetch(`/proposals/${id}`);
}

export async function getSystem() {
  return apiFetch("/system");
}
