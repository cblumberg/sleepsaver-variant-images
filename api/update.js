const SHOP = 'sleep-saver-nj';

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

async function getFileGid(token, filename, log) {
  const data = await gql(token,
    `query($q:String!){files(first:10,query:$q){edges{node{id ... on MediaImage{image{url}} ... on GenericFile{url}}}}}`,
    { q: `filename:${filename}` }
  );
  const edges = data?.files?.edges ?? [];
  const candidates = edges.map(e => {
    const url = e.node?.image?.url ?? e.node?.url ?? '';
    return { id: e.node?.id, name: url.split('/').pop().split('?')[0] };
  });
  if (log) log.push({ type: 'debug', msg: `search "${filename}" -> [${candidates.map(c => c.name || '(no url)').join(', ')}]` });
  const exact = candidates.find(c => c.name.toLowerCase() === filename.toLowerCase());
  return exact?.id ?? null;
}

async function getVariants(token, productId) {
  const variants = [];
  let cursor = null, hasNext = true;
  while (hasNext) {
    const data = await gql(token,
      `query($id:ID!,$c:String){product(id:$id){variants(first:100,after:$c){pageInfo{hasNextPage}edges{cursor node{id selectedOptions{name value}}}}}}`,
      { id: productId, c: cursor });
    const edges = data?.product?.variants?.edges ?? [];
    edges.forEach(e => variants.push(e.node));
    hasNext = data.product.variants.pageInfo.hasNextPage;
    cursor = edges[edges.length - 1]?.cursor ?? null;
  }
  return variants;
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
  const { productId, productTitle, fileCache } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });
  try {
    const token = await getToken();
    const variants = await getVariants(token, productId);
    const cache = { ...fileCache };
    let ok = 0, skipped = 0, errored = 0;
    const log = [];
    for (const variant of variants) {
      const colorOpt = variant.selectedOptions.find(o => o.name.toLowerCase() === 'color');
      if (!colorOpt) { skipped++; continue; }
      const filename = colorOpt.value.toLowerCase() + '.webp';
      if (!(filename in cache)) {
        cache[filename] = await getFileGid(token, filename, log);
      }
      const gid = cache[filename];
      if (!gid) {
        log.push({ type: 'skip', msg: `${colorOpt.value} — file not found` });
        skipped++;
        continue;
      }
      try {
        await setMetafield(token, variant.id, gid);
        log.push({ type: 'ok', msg: colorOpt.value });
        ok++;
      } catch (e) {
        log.push({ type: 'error', msg: `${colorOpt.value}: ${e.message}` });
        errored++;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    res.status(200).json({ ok, skipped, errored, log, cache });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
