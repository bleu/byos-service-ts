const ADMIN_API_URL = process.env.ADMIN_API_URL ?? "http://localhost:9587";

async function apiFetch(path: string, idToken: string) {
  const res = await fetch(`${ADMIN_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Admin API error: ${res.status} ${path}`);
  }
  return res.json();
}

export type TimeRange = "24h" | "7d" | "30d";

export async function getOverview(idToken: string, range: TimeRange = "24h") {
  return apiFetch(`/overview?range=${range}`, idToken);
}

export async function getSubsolvers(idToken: string, range: TimeRange = "24h") {
  return apiFetch(`/subsolvers?range=${range}`, idToken);
}

export async function getProposals(
  idToken: string,
  params: { subSolver?: string; status?: string; page?: number; limit?: number },
) {
  const qs = new URLSearchParams();
  if (params.subSolver) qs.set("subSolver", params.subSolver);
  if (params.status) qs.set("status", params.status);
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  return apiFetch(`/proposals?${qs}`, idToken);
}

export async function getProposal(idToken: string, id: number) {
  return apiFetch(`/proposals/${id}`, idToken);
}

export async function getSystem(idToken: string) {
  return apiFetch("/system", idToken);
}
