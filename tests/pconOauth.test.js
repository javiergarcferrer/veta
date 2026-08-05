// EL FLUJO OAUTH DE pCon.login, probado con un fetch de mentira.
//
// Este flujo no produce datos: produce UN STRING, el access token, que es lo
// unico que `EaiwsSession.open(..., { userToken })` necesita. Todo lo demas de
// la ruta pCon depende de que estas cuatro cosas esten bien: PKCE con S256, el
// `state` comparado entero, el secreto SOLO en Basic (nunca en el cuerpo) y el
// error de OAuth propagado con su texto —porque ese texto es el unico sitio
// donde se explica un problema de registro o de scope—.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeUrl, basicAuthHeader, createPkce, createState, exchangeCode,
  readRedirect, refresh, revoke, DEFAULT_SCOPES, LONGTERM_SCOPE, PCON_BASE_URL,
} from '../src/lib/pcon/oauth.ts';

/** Un fetch que apunta lo que le piden y responde lo que se le diga. */
function stubFetch(body, ok = true, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('PKCE es S256 y el verificador cabe en lo que pide la RFC', async () => {
  const pkce = await createPkce();
  assert.equal(pkce.method, 'S256');
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
  // base64url: ni +, ni /, ni relleno.
  assert.ok(!/[+/=]/.test(pkce.verifier), 'el verificador tiene que ser base64url');
  assert.ok(!/[+/=]/.test(pkce.challenge), 'el reto tiene que ser base64url');
  assert.notEqual(pkce.verifier, pkce.challenge, 'el reto es el hash, no el verificador');

  const otro = await createPkce();
  assert.notEqual(pkce.verifier, otro.verifier, 'cada peticion estrena verificador');
});

test('la URL de autorizacion lleva todo lo que documenta pCon', async () => {
  const pkce = await createPkce();
  const url = new URL(authorizeUrl({
    clientId: 'veta', redirectUri: 'https://veta.example/cb', challenge: pkce, state: 'st4te',
  }));
  assert.equal(url.origin + url.pathname, `${PCON_BASE_URL}/api/oauth2/authorize`);
  assert.equal(url.searchParams.get('client_id'), 'veta');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://veta.example/cb');
  assert.equal(url.searchParams.get('state'), 'st4te');
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'query_account');
});

test('SIN client_id el error dice donde se consigue', async () => {
  // No hay endpoint de registro. Si el mensaje no lo dice, el siguiente que lo
  // lea va a buscar un formulario que no existe.
  const pkce = await createPkce();
  assert.throws(
    () => authorizeUrl({ clientId: '', redirectUri: 'https://veta.example/cb', challenge: pkce, state: 's' }),
    /easterngraphics\.com/,
  );
});

test('el scope de larga duracion NO viaja en el flujo normal', () => {
  // Un refresh token infinito acunado en un navegador es una credencial que
  // sobrevive a la sesion que la creo.
  assert.ok(!DEFAULT_SCOPES.includes(LONGTERM_SCOPE));
  assert.deepEqual([...DEFAULT_SCOPES], ['query_account']);
});

test('el state se compara entero, y un error del redirect se propaga con su texto', () => {
  assert.equal(readRedirect('?code=abc&state=xyz', 'xyz'), 'abc');
  assert.throws(() => readRedirect('?code=abc&state=otro', 'xyz'), /state mismatch/);
  assert.throws(() => readRedirect('?state=xyz', 'xyz'), /no code/);
  // El unico sitio donde pCon explica un problema de registro o de scope.
  assert.throws(
    () => readRedirect('?error=invalid_scope&error_description=unknown+scope&state=xyz', 'xyz'),
    /invalid_scope.*unknown scope/,
  );
});

test('el codigo se canjea con el verificador, y el secreto va SOLO en Basic', async () => {
  const doFetch = stubFetch({
    token_type: 'Bearer', access_token: 'AT', refresh_token: 'RT',
    expires_in: 3600, scope: 'query_account',
  });
  const tokens = await exchangeCode({
    clientId: 'veta', code: 'c0de', redirectUri: 'https://veta.example/cb',
    verifier: 'v3rif1er', basicAuth: basicAuthHeader('veta', 's3cret'), fetchImpl: doFetch,
  });
  assert.deepEqual(tokens, {
    tokenType: 'Bearer', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'query_account',
  });

  const [call] = doFetch.calls;
  assert.equal(call.url, `${PCON_BASE_URL}/api/oauth2/request_token`);
  assert.equal(call.form.grant_type, 'authorization_code');
  assert.equal(call.form.code_verifier, 'v3rif1er');
  assert.equal(call.form.redirect_uri, 'https://veta.example/cb');
  assert.equal(call.init.headers.Authorization, `Basic ${Buffer.from('veta:s3cret').toString('base64')}`);
  // Lo que NUNCA puede pasar: el secreto en el cuerpo del formulario.
  assert.equal(call.form.client_secret, undefined);
});

test('un cliente publico no manda Authorization en absoluto', async () => {
  // El estudio corre en el navegador: un secreto en el bundle es un secreto
  // publicado, asi que ese flujo es PKCE a secas.
  const doFetch = stubFetch({ access_token: 'AT', refresh_token: 'RT', expires_in: 60 });
  await exchangeCode({
    clientId: 'veta', code: 'c', redirectUri: 'https://veta.example/cb',
    verifier: 'v', fetchImpl: doFetch,
  });
  assert.equal(doFetch.calls[0].init.headers.Authorization, undefined);
});

test('un error OAuth se propaga con su descripcion aunque el HTTP sea 400', async () => {
  const doFetch = stubFetch(
    { error: 'invalid_client', error_description: 'unknown client_id' }, false, 400,
  );
  await assert.rejects(
    exchangeCode({ clientId: 'x', code: 'c', redirectUri: 'r', verifier: 'v', fetchImpl: doFetch }),
    /invalid_client.*unknown client_id/,
  );
});

test('una respuesta sin access_token es un fallo, no un token vacio', async () => {
  const doFetch = stubFetch({ token_type: 'Bearer' });
  await assert.rejects(
    exchangeCode({ clientId: 'x', code: 'c', redirectUri: 'r', verifier: 'v', fetchImpl: doFetch }),
    /no access_token/,
  );
});

test('el refresh devuelve el token entero, porque puede haber rotado', async () => {
  // Un refresh token normal PUEDE volver cambiado; solo el de larga duracion no
  // rota. Por eso el llamante persiste lo que recibe en vez de asumir el suyo.
  const doFetch = stubFetch({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
  const tokens = await refresh({ clientId: 'veta', refreshToken: 'RT1', fetchImpl: doFetch });
  assert.equal(tokens.accessToken, 'AT2');
  assert.equal(tokens.refreshToken, 'RT2');
  assert.equal(doFetch.calls[0].form.grant_type, 'refresh_token');
  assert.equal(doFetch.calls[0].form.refresh_token, 'RT1');
});

test('revocar manda el token y su pista', async () => {
  const doFetch = stubFetch({});
  await revoke({ token: 'RT', fetchImpl: doFetch });
  assert.equal(doFetch.calls[0].url, `${PCON_BASE_URL}/api/oauth2/revoke_token`);
  assert.equal(doFetch.calls[0].form.token, 'RT');
  assert.equal(doFetch.calls[0].form.token_type_hint, 'refresh_token');
});
