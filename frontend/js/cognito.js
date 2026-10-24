// Minimal Amazon Cognito client for the host: password sign-in, optional authenticator code, token refresh.
// Talks straight to the Cognito endpoint over TLS (no SDK, no hosted UI). See decision D24.
export class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AuthError';
    this.code = code;
  }
}

const MAP = {
  NotAuthorizedException: 'bad_login',
  UserNotFoundException: 'bad_login',
  UserNotConfirmedException: 'bad_login',
  PasswordResetRequiredException: 'reset_required',
  TooManyRequestsException: 'too_many',
  LimitExceededException: 'too_many',
  CodeMismatchException: 'bad_mfa',
  ExpiredCodeException: 'bad_mfa',
};

export function createCognito({ region, clientId, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function call(target, payload) {
    let res;
    try {
      res = await doFetch(`https://cognito-idp.${region}.amazonaws.com/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${target}` },
        body: JSON.stringify(payload),
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (e) {
      throw new AuthError('network', 'Cannot reach the sign-in service');
    }
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    if (!res.ok) {
      const type = String(data.__type || '').split('#').pop();
      throw new AuthError(MAP[type] || 'error', data.message || type || `HTTP ${res.status}`);
    }
    return data;
  }

  const tokens = (r, refreshToken) => ({
    idToken: r.IdToken,
    refreshToken: r.RefreshToken || refreshToken,
    expiresAt: Date.now() + (r.ExpiresIn || 3600) * 1000,
  });

  return {
    // Returns tokens, or { challenge, session, username } when an authenticator code is needed.
    async signIn(username, password) {
      const d = await call('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password } });
      if (d.ChallengeName === 'SOFTWARE_TOKEN_MFA') return { challenge: 'totp', session: d.Session, username };
      if (d.ChallengeName) throw new AuthError('unsupported_challenge', d.ChallengeName);
      return tokens(d.AuthenticationResult);
    },
    async answerTotp({ session, username }, code) {
      const d = await call('RespondToAuthChallenge', { ChallengeName: 'SOFTWARE_TOKEN_MFA', ClientId: clientId, Session: session, ChallengeResponses: { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: code } });
      return tokens(d.AuthenticationResult);
    },
    async refresh(refreshToken) {
      const d = await call('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } });
      return tokens(d.AuthenticationResult, refreshToken);
    },
  };
}
