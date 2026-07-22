import { useAuthStore } from '../stores/auth-store';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Per-field validation messages, when the server returned an array (400s). */
    public details?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Centralized API client for the dashboard BFF. Injects the JWT, resolves the
 * base URL from config (never hardcode paths in features), and clears auth on
 * 401 so the app falls back to the login screen.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    useAuthStore.getState().clear();
  }

  if (!res.ok) {
    let message = res.statusText;
    let details: string[] | undefined;
    try {
      const body = await res.json();
      if (typeof body?.error === 'string') {
        message = body.error;
      } else if (Array.isArray(body?.error)) {
        details = body.error;
        message = body.error.join('; ');
      } else {
        message = body?.message ?? JSON.stringify(body?.error ?? body);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};
