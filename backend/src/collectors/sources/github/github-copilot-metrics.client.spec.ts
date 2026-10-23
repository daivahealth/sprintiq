import { gzipSync } from 'node:zlib';
import {
  COPILOT_METRICS_API_VERSION,
  GithubCopilotMetricsClient,
  isAllowedReportUrl,
  nextApiLink,
  parseNdjson,
  redactQuery,
} from './github-copilot-metrics.client';

function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bytes?: Buffer;
}) {
  const status = opts.status ?? 200;
  const headers = new Map(Object.entries(opts.headers ?? {}));
  const bytes = opts.bytes ?? Buffer.from('');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    json: async () => opts.body ?? {},
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  };
}

const REPORT_URL =
  'https://copilot-reports.github.com/reports/users-1-day/2026-10-12.ndjson?sig=SECRET';

describe('GithubCopilotMetricsClient.getUsersDayReport', () => {
  const client = new GithubCopilotMetricsClient();
  afterEach(() => jest.restoreAllMocks());

  it('calls the org users-1-day endpoint with the usage-metrics API version', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      fakeResponse({
        body: { download_links: [REPORT_URL], report_day: '2026-10-12' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await client.getUsersDayReport(
      'athmahealth',
      '2026-10-12',
      'tok',
    );

    expect(result).toEqual({
      status: 'ok',
      links: [REPORT_URL],
      reportDay: '2026-10-12',
    });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(
      'https://api.github.com/orgs/athmahealth/copilot/metrics/reports/users-1-day?day=2026-10-12',
    );
    expect(init.headers['X-GitHub-Api-Version']).toBe(
      COPILOT_METRICS_API_VERSION,
    );
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('reads 204 as "not ready yet", not as a failure', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ status: 204 }),
      ) as unknown as typeof fetch;
    await expect(
      client.getUsersDayReport('o', '2026-10-14', 'tok'),
    ).resolves.toEqual({ status: 'not_ready' });
  });

  it('tells a refusal (403) from a rate limit (403 with remaining 0)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 403 }))
      .mockResolvedValueOnce(
        fakeResponse({
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1800000000',
          },
        }),
      ) as unknown as typeof fetch;

    await expect(
      client.getUsersDayReport('o', '2026-10-12', 'tok'),
    ).resolves.toEqual({ status: 'forbidden', httpStatus: 403 });
    await expect(
      client.getUsersDayReport('o', '2026-10-12', 'tok'),
    ).resolves.toEqual({
      status: 'rate_limited',
      resetAt: new Date(1_800_000_000_000),
    });
  });

  it('maps 404 to not_found', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ status: 404 }),
      ) as unknown as typeof fetch;
    await expect(
      client.getUsersDayReport('o', '2026-10-12', 'tok'),
    ).resolves.toEqual({ status: 'not_found', httpStatus: 404 });
  });

  it('never calls GitHub with a blank token', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await client.getUsersDayReport('o', '2026-10-12', '');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GithubCopilotMetricsClient.downloadReport', () => {
  const client = new GithubCopilotMetricsClient();
  afterEach(() => jest.restoreAllMocks());

  it('downloads without an Authorization header and parses NDJSON', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      fakeResponse({
        bytes: Buffer.from('{"user_login":"a"}\n{"user_login":"b"}\n'),
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await client.downloadReport(REPORT_URL);

    expect(result).toEqual({
      status: 'ok',
      records: [{ user_login: 'a' }, { user_login: 'b' }],
      malformedLines: 0,
    });
    // The URL is signed; the GitHub token must never travel to the download host.
    expect(fetchMock).toHaveBeenCalledWith(REPORT_URL);
  });

  it('inflates a gzipped report', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        bytes: gzipSync(Buffer.from('{"user_login":"a"}\n')),
      }),
    ) as unknown as typeof fetch;
    const result = await client.downloadReport(REPORT_URL);
    expect(result).toMatchObject({ records: [{ user_login: 'a' }] });
  });

  it('refuses a URL on any other host without fetching it', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await client.downloadReport(
      'https://169.254.169.254/latest/meta-data',
    );
    expect(result).toEqual({ status: 'error', reason: 'unexpected_host' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GithubCopilotMetricsClient.listSeats', () => {
  const client = new GithubCopilotMetricsClient();
  afterEach(() => jest.restoreAllMocks());

  it('follows rel="next" across pages', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          headers: {
            link: '<https://api.github.com/orgs/o/copilot/billing/seats?per_page=100&page=2>; rel="next"',
          },
          body: { seats: [{ assignee: { login: 'a', id: 1 } }] },
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          body: { seats: [{ assignee: { login: 'b', id: 2 } }] },
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await client.listSeats('o', 'tok');

    expect(result).toEqual({
      status: 'ok',
      truncated: false,
      seats: [
        { assignee: { login: 'a', id: 1 } },
        { assignee: { login: 'b', id: 2 } },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a refused seat list as forbidden', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ status: 403 }),
      ) as unknown as typeof fetch;
    await expect(client.listSeats('o', 'tok')).resolves.toEqual({
      status: 'forbidden',
      httpStatus: 403,
    });
  });
});

describe('copilot client helpers', () => {
  it('parseNdjson counts and skips malformed lines', () => {
    expect(parseNdjson('{"a":1}\r\nnot json\n[1]\n\n{"b":2}')).toEqual({
      records: [{ a: 1 }, { b: 2 }],
      malformedLines: 2,
    });
  });

  it('isAllowedReportUrl accepts only https on the report host', () => {
    expect(isAllowedReportUrl(REPORT_URL)).toBe(true);
    expect(
      isAllowedReportUrl('http://copilot-reports.github.com/x.ndjson'),
    ).toBe(false);
    expect(
      isAllowedReportUrl('https://copilot-reports.github.com.evil.test/x'),
    ).toBe(false);
    expect(isAllowedReportUrl('not a url')).toBe(false);
  });

  it('redactQuery drops the signature', () => {
    expect(redactQuery(REPORT_URL)).toBe(
      'https://copilot-reports.github.com/reports/users-1-day/2026-10-12.ndjson?<redacted>',
    );
  });

  it('nextApiLink never leaves api.github.com', () => {
    expect(nextApiLink('<https://api.github.com/x?page=2>; rel="next"')).toBe(
      'https://api.github.com/x?page=2',
    );
    expect(nextApiLink('<https://evil.test/x?page=2>; rel="next"')).toBe(
      undefined,
    );
    expect(nextApiLink('<https://api.github.com/x?page=1>; rel="prev"')).toBe(
      undefined,
    );
  });
});
