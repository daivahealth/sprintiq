import { Logger } from '@nestjs/common';
import { TeamsClient } from './teams.client';

const URL_WITH_CREDENTIAL =
  'https://prod-11.centralindia.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SUPERSECRET';

function clientWith(fetchImpl: jest.Mock) {
  global.fetch = fetchImpl as unknown as typeof fetch;
  const secrets = { resolve: jest.fn().mockResolvedValue(URL_WITH_CREDENTIAL) };
  return { client: new TeamsClient(secrets as never), secrets };
}

describe('TeamsClient', () => {
  const card = { type: 'message', attachments: [] };

  afterEach(() => jest.restoreAllMocks());

  it('treats 202 with an empty body as success', async () => {
    // Power Automate answers 202 Accepted with no body, unlike the retired
    // O365 connector's 200/"1". A strict 200-only check logs every
    // successful send as a failure.
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and succeeds on a later attempt', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'slow down',
      })
      .mockResolvedValueOnce({ ok: true, status: 202, text: async () => '' });
    const { client } = clientWith(fetchMock);

    await client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 server error and succeeds on a later attempt', async () => {
    // 5xx status codes are transient; retry is the right move. This test
    // ensures the RETRYABLE predicate covers >= 500, locking retry behavior
    // for 5xx the same way 429 is tested.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'internal server error',
      })
      .mockResolvedValueOnce({ ok: true, status: 202, text: async () => '' });
    const { client } = clientWith(fetchMock);

    await client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 403 — the flow is gone or the URL rotated', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'forbidden',
    });
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never writes the webhook URL to the log', async () => {
    // The URL carries its credential in the query string; logging it hands
    // channel-post rights to anyone with log access.
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message) => {
      logged.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      logged.push(String(message));
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow();

    expect(logged.join('\n')).not.toContain('SUPERSECRET');
    expect(logged.join('\n')).not.toContain('logic.azure.com');
  });

  it('never leaks the URL when fetch rejects instead of resolving', async () => {
    // Node throws `TypeError: Failed to parse URL from <the whole string>`
    // for a malformed URL — a copy-paste line wrap is enough to trigger it —
    // and that rejection message embeds the URL and its credential. Unlike a
    // bad HTTP status, this never produces a `response` object, so it must be
    // caught separately from the status-code path below.
    const rejection = new TypeError(
      `Failed to parse URL from ${URL_WITH_CREDENTIAL}`,
    );
    const fetchMock = jest.fn().mockRejectedValue(rejection);
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow(/teamsWebhookRef/);

    let thrown: unknown;
    try {
      await client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card);
    } catch (error) {
      thrown = error;
    }
    expect(String((thrown as Error).message)).not.toContain('SUPERSECRET');
    expect(String((thrown as Error).message)).not.toContain('logic.azure.com');
  });

  it('does not log the URL when fetch rejects instead of resolving', async () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message) => {
      logged.push(String(message));
    });
    const rejection = new TypeError(
      `Failed to parse URL from ${URL_WITH_CREDENTIAL}`,
    );
    const fetchMock = jest.fn().mockRejectedValue(rejection);
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow();

    expect(logged.join('\n')).not.toContain('SUPERSECRET');
    expect(logged.join('\n')).not.toContain('logic.azure.com');
  });

  it('fails clearly when no webhook is configured', async () => {
    const fetchMock = jest.fn();
    const { client, secrets } = clientWith(fetchMock);
    secrets.resolve.mockResolvedValue(null);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow(/teamsWebhookRef/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
