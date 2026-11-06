// Google Places API (New) — Text Search. Uma chamada por pedido (telefone/rating são SKU Enterprise).
export interface Candidate {
  name: string;
  phone: string | null;
  rating: number | null;
  reviews: number | null;
  address: string | null;
  website: string | null;
  placeId: string | null;
  source: 'google' | 'web' | 'teste';
}

const FIELD_MASK = [
  'places.id', 'places.displayName.text', 'places.rating', 'places.userRatingCount',
  'places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.formattedAddress',
  'places.websiteUri', 'places.businessStatus',
].join(',');

export function hasPlaces(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

export async function searchPlaces(textQuery: string): Promise<Candidate[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY!,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
      includePureServiceAreaBusinesses: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Places ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { places?: any[] };
  return (data.places ?? [])
    .filter((p) => !p.businessStatus || p.businessStatus === 'OPERATIONAL')
    .map((p): Candidate => ({
      name: p.displayName?.text ?? 'Sem nome',
      phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      address: p.formattedAddress ?? null,
      website: p.websiteUri ?? null,
      placeId: p.id ?? null,
      source: 'google',
    }))
    .filter((c) => c.phone && (c.rating == null || c.rating >= 4.0));
}
