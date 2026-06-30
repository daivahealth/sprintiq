import { Injectable } from '@nestjs/common';
import { SignatureVerifier } from './signature-verifier';
import { GithubSignatureVerifier } from './verifiers/github.verifier';

/**
 * Registry of per-provider signature verifiers. New sources register here as
 * their collectors are built (GitLab token, Jira/ADO secret/JWT, Sonar HMAC,
 * Jenkins token — see docs/api/README.md §2.2).
 */
@Injectable()
export class SignatureVerifierRegistry {
  private readonly verifiers = new Map<string, SignatureVerifier>();

  constructor() {
    this.register(new GithubSignatureVerifier());
    // this.register(new GitlabSignatureVerifier()); ...
  }

  register(verifier: SignatureVerifier): void {
    this.verifiers.set(verifier.source, verifier);
  }

  get(source: string): SignatureVerifier | undefined {
    return this.verifiers.get(source);
  }
}
