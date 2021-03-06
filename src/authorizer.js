const axios = require('axios');
const jwtManager = require('jsonwebtoken');
const jwkConverter = require('jwk-to-pem');

class Authorizer {
  /**
   * Constructor
   * @param {Function} logFunction log function, defaults to console.log
   * @param {Object}   configuration configuration object
   * @param {String}   configuration.jwkKeyListUrl url used to retrieve the jwk public keys
   * @param {String}   configuration.authorizerContextResolver function to populate the authorizer context, by default it will only contain the JWT. function(identity, token) {}
   */
  constructor(logFunction, configuration = {}) {
    this.logFunction = logFunction || console.log;
    if (!configuration.jwkKeyListUrl) {
      throw new Error('Authorizer configuration error: missing required property "jwkKeyListUrl"');
    }
    this.configuration = configuration;
    this.publicKeysPromise = null;
  }

  async getPublicKeyPromise(kid) {
    if (!this.publicKeysPromise) {
      this.publicKeysPromise = axios.get(this.configuration.jwkKeyListUrl);
    }
    let result = null;
    try {
      result = await this.publicKeysPromise;
    } catch (error) {
      this.publicKeysPromise = null;
      this.logFunction({ level: 'ERROR', title: 'InternalServerError', details: 'Failed to get public key', error: error });
      throw new Error('InternalServerError');
    }

    let jwk = result.data.keys.find(key => key.kid === kid);
    if (jwk) {
      return jwkConverter(jwk);
    }
    this.publicKeysPromise = null;
    this.logFunction({ level: 'WARN', title: 'Unauthorized', details: 'KID not found in public key list.', kid: kid || 'NO_KID_SPECIFIED', keys: result.data.keys });
    throw new Error('Unauthorized');
  }

  async getPolicy(request) {
    this.logFunction({ level: 'INFO', title: 'Authorizer.getPolicy()', data: request });
    let methodArn = request.methodArn;
    let token = this.getTokenFromAuthorizationHeader(request);
    if (!token) {
      this.logFunction({ level: 'WARN', title: 'Unauthorized', details: 'No token specified', method: methodArn });
      throw new Error('Unauthorized');
    }

    let unverifiedToken = jwtManager.decode(token, { complete: true });
    if (!unverifiedToken) {
      this.logFunction({ level: 'WARN', title: 'Unauthorized', details: 'Invalid token', method: methodArn });
      throw new Error('Unauthorized');
    }

    let kid = unverifiedToken && unverifiedToken.header && unverifiedToken.header.kid;
    if (!kid) {
      this.logFunction({ level: 'WARN', title: 'Unauthorized', details: 'Token did no provide a KID', method: methodArn, token });
      throw new Error('Unauthorized');
    }

    let key = await this.getPublicKeyPromise(kid);
    let identity;
    try {
      identity = await jwtManager.verify(token, key, { algorithms: ['RS256'] });
    } catch (exception) {
      this.logFunction({ level: 'WARN', title: 'Unauthorized', details: 'Error verifying token', error: exception, method: methodArn });
      throw new Error('Unauthorized');
    }

    let resolver = this.configuration.authorizerContextResolver || (() => ({ jwt: token }));
    return {
      principalId: identity.sub,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'execute-api:Invoke'
            ],
            Resource: [
              'arn:aws:execute-api:*:*:*'
            ]
          }
        ]
      },
      context: resolver(identity, token)
    };
  }

  getTokenFromAuthorizationHeader(request) {
    let authorizationHeaderKey = Object.keys(request.headers || {})
      .find(headerKey => headerKey.toLowerCase() === 'authorization') || null;
    let authorizationHeader = authorizationHeaderKey ? request.headers[authorizationHeaderKey] : null;
    let authorizationHeaderFragments = authorizationHeader ? authorizationHeader.split(' ') : [];
    return authorizationHeaderFragments.length === 2 ? authorizationHeaderFragments[1] : null;
  }
}

module.exports = Authorizer;
