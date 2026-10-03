/**
 * Minimal client for the Vast.ai REST API. It covers what LLM inference needs
 * from a GPU rental:
 *   - num_gpus / gpu_total_ram   -> to filter machines by GPU count and VRAM.
 *   - public_ipaddr + ports      -> to reach the OpenAI-compatible endpoint
 *                                   served by Ollama on the rented machine.
 *
 * Security: the API key lives ONLY on the server (env VAST_API_KEY). It never
 * travels to the frontend. `fetchImpl` is injectable for network-free tests.
 */

const VAST_API_BASE = "https://console.vast.ai/api/v0";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v) {
  return typeof v === "string" && v ? v : undefined;
}
/** Multiplies two possibly-undefined values; if either is missing, returns undefined. */
function mulOrNull(a, b) {
  return a != null && b != null ? a * b : undefined;
}
/** VRAM in MB -> rounded GB; undefined if the datum is missing (we do not invent 0). */
function vramGb(mb) {
  return mb != null ? Math.round(mb / 1024) : undefined;
}

/** Vast API error carrying the status so the proxy can map the HTTP code. */
export class VastApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "VastApiError";
    this.status = status;
  }
}

/**
 * Does the error mean the offer (ask) has evaporated? Vast offers are
 * ephemeral: between the search and the PUT /asks/<id>/, another client can
 * grab it or it can expire. Vast replies 400 with "no_such_ask" / "is not
 * available". In that case it is better to retry with the next offer than to
 * abort the rental.
 */
export function isStaleOfferError(err) {
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("no_such_ask") || msg.includes("is not available");
}

/** Maps a raw API offer to the shape we use. */
export function mapOffer(raw) {
  const numGpus = num(raw.num_gpus) ?? 1;
  const perGpuMb = num(raw.gpu_ram) ?? 0;
  const totalMb = num(raw.gpu_total_ram) ?? perGpuMb * numGpus;
  return {
    id: num(raw.id) ?? 0,
    gpuName: str(raw.gpu_name) ?? "?",
    numGpus,
    perGpuVramGb: Math.round(perGpuMb / 1024),
    totalVramGb: Math.round(totalMb / 1024),
    dphTotal: num(raw.dph_total) ?? 0,
    inetDown: num(raw.inet_down),
    reliability: num(raw.reliability2) ?? num(raw.reliability),
    machineId: num(raw.machine_id),
    driverVersion: str(raw.driver_version),
    geolocation: str(raw.geolocation),
    cudaMax: num(raw.cuda_max_good),
    // GPU compute capability (V100=700, Turing=750, A100=800, RTX4090=890).
    // Critical: modern CUDA kernels require >= 750.
    computeCap: num(raw.compute_cap),
  };
}

/** Extracts the host port mapped to a container port (e.g. 11434/tcp). */
function extractMappedPort(ports, containerPort) {
  if (!ports || typeof ports !== "object") return undefined;
  const entry = ports[`${containerPort}/tcp`];
  if (!Array.isArray(entry) || entry.length === 0) return undefined;
  return num(Number(entry[0]?.HostPort));
}

/** Maps a raw API instance to the shape we use. */
export function mapInstance(raw) {
  return {
    id: num(raw.id) ?? 0,
    actualStatus: str(raw.actual_status),
    // Vast contract state: `cur_state`/`intended_status` reflect the contract's
    // intent (running/stopped) even when `actual_status` is still empty in the
    // first few seconds. Key signals for reconciling orphaned instances.
    curState: str(raw.cur_state),
    intendedStatus: str(raw.intended_status),
    statusMsg: str(raw.status_msg),
    publicIp: str(raw.public_ipaddr),
    sshHost: str(raw.ssh_host),
    sshPort: num(raw.ssh_port),
    // Physical host data to rebuild the `offer` when adopting an orphaned
    // instance (the panel lost track of it but the GPU is still billing).
    gpuName: str(raw.gpu_name),
    numGpus: num(raw.num_gpus),
    dphTotal: num(raw.dph_total),
    machineId: num(raw.machine_id),
    // Bundle VRAM so the reconciled offer keeps the real capacity (without it,
    // the panel showed "undefinedGB" after reconciling on boot).
    perGpuVramGb: vramGb(num(raw.gpu_ram)),
    totalVramGb: vramGb(num(raw.gpu_total_ram) ?? mulOrNull(num(raw.gpu_ram), num(raw.num_gpus))),
    // Epoch (seconds) at which the contract started -> anchor for the uptime timer.
    startDate: num(raw.start_date),
    label: str(raw.label),
    image: str(raw.image_uuid),
    // Host port where Vast published the container's 11434 (Ollama API).
    apiPort: extractMappedPort(raw.ports, 11434),
  };
}

/**
 * Creates the Vast HTTP client. The key is injected once; `fetchImpl` lets
 * tests swap out `fetch`. Throws `VastApiError` with the status on failures.
 */
export function createVastApiClient({ apiKey, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function call(path, init) {
    const res = await doFetch(`${VAST_API_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      /* v8 ignore next -- defensive guard: only if text() rejects */
      const detail = await res.text().catch(() => "");
      throw new VastApiError(
        `Vast API ${path} → ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        res.status,
      );
    }
    return res.json();
  }

  return {
    async getAccount() {
      const data = await call("/users/current/");
      return {
        id: num(data.id) ?? 0,
        email: str(data.email),
        balance: num(data.credit) ?? num(data.balance),
      };
    },

    async searchOffers(query) {
      const q = encodeURIComponent(JSON.stringify(query));
      const data = await call(`/bundles/?q=${q}`);
      const offers = Array.isArray(data.offers) ? data.offers : [];
      return offers.map((o) => mapOffer(o));
    },

    async createInstance(offerId, body) {
      const data = await call(`/asks/${offerId}/`, { method: "PUT", body });
      const id = num(data.new_contract) ?? num(data.new_instance_id) ?? 0;
      return { newInstanceId: id };
    },

    async destroyInstance(instanceId) {
      await call(`/instances/${instanceId}/`, { method: "DELETE" });
    },

    async getInstance(instanceId) {
      const data = await call(`/instances/${instanceId}/`);
      const raw = data.instances ?? data;
      if (!raw || typeof raw !== "object") return null;
      return mapInstance(raw);
    },

    async listInstances() {
      const data = await call("/instances/");
      const list = Array.isArray(data.instances) ? data.instances : [];
      return list.map((i) => mapInstance(i));
    },
  };
}
