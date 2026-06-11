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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const token = await getToken();
    const products = [];
    let cursor = null, hasNext = true;
    while (hasNext) {
      const data = await gql(token,
        `query($h:String!,$c:String){collectionByHandle(handle:$h){products(first:50,after:$c){pageInfo{hasNextPage}edges{cursor node{id title}}}}}`,
        { h: COLLECTION, c: cursor });
      const edges = data?.collectionByHandle?.products?.edges ?? [];
      edges.forEach(e => products.push(e.node));
      hasNext = data.collectionByHandle.products.pageInfo.hasNextPage;
      cursor = edges[edges.length - 1]?.cursor ?? null;
    }
    res.status(200).json({ products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
