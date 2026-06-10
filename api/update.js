const SHOP = 'sleep-saver-nj';
const COLLECTION = 'semi-custom-beds';

async function getToken() {
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
}

async function gql(token, query, variables) {
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL failed: ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(JSON.stringify(errors));
  return data;
}

async function getFileGid(token, filename) {
  const data = await gql(token, `query($q:String!){files(first:1,query:$q){edges{node{id}}}}`, { q: `filename:${filename}` });
  return data?.files?.edges?.[0]?.node?.id ?? null;
}

async function getProducts(token) {
  const products = [];
  let cursor = null, hasNext = true;
  while (hasNext) {
    const data = await gql(token,
      `query($h:String!,$c:String){collectionByHandle(handle:$h){products(first:50,after:$c){pageInfo{hasNextPage}edges{cursor node{id title variants(first:100){edges{node{id selectedOptions{name value}}}}}}}}}`
      , { h: COLLECTION, c: cursor });
    const edges = data?.collectionByHandle?.products?.edges ?? [];
    edges.forEach(e => products.push(e.node));
    hasNext = data.collectionByHandle.products.pageInfo.hasNextPage;
    cursor = edges[edges.length - 1]?.cursor ?? null;
  }
  return products;
}

async function setMetafield(token, variantId, fileGid) {
  const data = await gql(token,
    `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{field message}}}`,
    { m: [{ ownerId: variantId, namespace: 'custom', key: 'swatch_image', value: fileGid, type: 'file_reference' }] }
  );
  const errs = data?.metafieldsSet?.userErrors;
  if (errs?.length) throw new Error(JSON.stringify(errs));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ type: 'info', msg: 'Getting access token...' });
    const token = await getToken();

    send({ type: 'info', msg: 'Fetching products...' });
    const products = await getProducts(token);
    send({ type: 'info', msg: `Found ${products.length} products` });

    const cache = {};
    let ok = 0, skipped = 0, errored = 0;

    for (const product of products) {
      send({ type: 'product', msg: product.title });
      for (const { node: variant } of product.variants.edges) {
        const colorOpt = variant.selectedOptions.find(o => o.name.toLowerCase() === 'color');
        if (!colorOpt) { skipped++; continue; }

        const filename = colorOpt.value.toLowerCase() + '.webp';
        if (!(filename in cache)) {
          cache[filename] = await getFileGid(token, filename);
        }
        const gid = cache[filename];

        if (!gid) {
          send({ type: 'skip', msg: `${colorOpt.value} — file not found` });
          skipped++;
          continue;
        }

        try {
          await setMetafield(token, variant.id, gid);
          send({ type: 'ok', msg: colorOpt.value });
          ok++;
        } catch (e) {
          send({ type: 'error', msg: `${colorOpt.value}: ${e.message}` });
          errored++;
        }

        await new Promise(r => setTimeout(r, 150));
      }
    }

    send({ type: 'done', ok, skipped, errored });
  } catch (e) {
    send({ type: 'fatal', msg: e.message });
  }

  res.end();
}
