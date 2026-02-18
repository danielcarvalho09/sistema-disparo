const fs = require('node:fs/promises');

const GOOGLE_PLACES_BASE_URL = 'https://maps.googleapis.com/maps/api/place';

/**
 * Parse a CSV line handling quoted fields.
 * Lightweight parser to keep loadLeadsFromCsv dependency-free.
 */
function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

/**
 * Best-effort normalization to E.164 format.
 * Returns null when it cannot safely normalize.
 */
function toE164(phone, defaultCountryCode = '') {
  if (!phone || typeof phone !== 'string') return null;

  const trimmed = phone.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return null;
  }

  if (trimmed.startsWith('00')) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 17) return `+${digits.slice(2)}`;
    return null;
  }

  const localDigits = trimmed.replace(/\D/g, '');
  const countryDigits = String(defaultCountryCode || '').replace(/\D/g, '');

  if (!localDigits) return null;

  if (countryDigits && localDigits.length >= 8) {
    return `+${countryDigits}${localDigits}`;
  }

  return null;
}

function deduplicatePhones(phones) {
  return [...new Set(phones.filter(Boolean))];
}

function buildSearchRequestUrl(params) {
  const {
    apiKey,
    query,
    keyword,
    location,
    radius,
    type,
    language,
    region,
  } = params;

  if (!apiKey) throw new Error('Google Places apiKey is required.');

  const useNearbySearch = Boolean(location && radius);
  const endpoint = useNearbySearch ? 'nearbysearch' : 'textsearch';
  const url = new URL(`${GOOGLE_PLACES_BASE_URL}/${endpoint}/json`);

  url.searchParams.set('key', apiKey);

  if (useNearbySearch) {
    url.searchParams.set('location', `${location.lat},${location.lng}`);
    url.searchParams.set('radius', String(radius));

    if (keyword) url.searchParams.set('keyword', keyword);
    if (query && !keyword) url.searchParams.set('keyword', query);
    if (type) url.searchParams.set('type', type);
  } else {
    const textQuery = query || keyword;
    if (!textQuery) {
      throw new Error('Provide either query or keyword for Google Places search.');
    }
    url.searchParams.set('query', textQuery);
    if (type) url.searchParams.set('type', type);
  }

  if (language) url.searchParams.set('language', language);
  if (region) url.searchParams.set('region', region);

  return url;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Places request failed with status ${response.status}`);
  }
  return response.json();
}

async function fetchAllPlaceCandidates(params) {
  const firstUrl = buildSearchRequestUrl(params);
  const places = [];
  let nextPageToken = null;
  let pageCount = 0;

  do {
    const url = new URL(firstUrl.toString());
    if (nextPageToken) {
      url.searchParams.set('pagetoken', nextPageToken);
      // Google Places pagination token can need a short delay to become active.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const data = await fetchJson(url);

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places search error: ${data.status}`);
    }

    if (Array.isArray(data.results)) {
      places.push(...data.results);
    }

    nextPageToken = data.next_page_token || null;
    pageCount += 1;
  } while (nextPageToken && pageCount < 3);

  return places;
}

async function fetchPlaceDetails(apiKey, placeId, language) {
  const detailsUrl = new URL(`${GOOGLE_PLACES_BASE_URL}/details/json`);
  detailsUrl.searchParams.set('key', apiKey);
  detailsUrl.searchParams.set('place_id', placeId);
  detailsUrl.searchParams.set(
    'fields',
    [
      'place_id',
      'name',
      'formatted_address',
      'formatted_phone_number',
      'international_phone_number',
    ].join(','),
  );
  if (language) detailsUrl.searchParams.set('language', language);

  const data = await fetchJson(detailsUrl);

  if (data.status !== 'OK') {
    return null;
  }

  return data.result || null;
}

/**
 * Fetches leads from official Google Places API endpoints.
 *
 * IMPORTANT:
 * - You must provide your own Google Maps/Places API key.
 * - Configure query/keyword/location/radius/type according to your prospecting scenario.
 * - Use must follow Google Terms of Service and local privacy/anti-spam laws.
 */
async function fetchLeadsFromGooglePlaces(params) {
  const {
    apiKey,
    language,
    defaultCountryCode,
  } = params || {};

  if (!apiKey) throw new Error('Missing apiKey for Google Places API.');

  const candidates = await fetchAllPlaceCandidates(params);
  const detailedLeads = [];

  for (const candidate of candidates) {
    if (!candidate.place_id) continue;

    const details = await fetchPlaceDetails(apiKey, candidate.place_id, language);
    if (!details) continue;

    const rawPhone = details.international_phone_number || details.formatted_phone_number;
    if (!rawPhone) continue;

    detailedLeads.push({
      name: details.name || candidate.name || null,
      address: details.formatted_address || candidate.formatted_address || null,
      phone: rawPhone,
      placeId: details.place_id || candidate.place_id,
    });
  }

  const normalizedPhones = deduplicatePhones(
    detailedLeads
      .map((lead) => toE164(lead.phone, defaultCountryCode))
      .filter(Boolean),
  );

  return normalizedPhones;
}

/**
 * Loads leads from CSV, expecting a `phone` column.
 */
async function loadLeadsFromCsv(filePath, options = {}) {
  const csvContent = await fs.readFile(filePath, 'utf-8');
  const rows = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!rows.length) return [];

  const headers = parseCsvLine(rows[0]).map((h) => h.toLowerCase());
  const phoneIndex = headers.indexOf('phone');

  if (phoneIndex < 0) {
    throw new Error('CSV must contain a `phone` column.');
  }

  const phones = rows.slice(1).map((row) => {
    const cols = parseCsvLine(row);
    return toE164(cols[phoneIndex], options.defaultCountryCode);
  });

  return deduplicatePhones(phones);
}

/**
 * Convenience function to choose lead source.
 *
 * Set source to:
 * - "google": fetch from Google Places API.
 * - "csv": load from local CSV file.
 */
async function getQualifiedLeads(config = {}) {
  const source = config.source || 'google';

  if (source === 'google') {
    return fetchLeadsFromGooglePlaces(config.google || {});
  }

  if (source === 'csv') {
    if (!config.csv || !config.csv.filePath) {
      throw new Error('For CSV source, provide config.csv.filePath.');
    }
    return loadLeadsFromCsv(config.csv.filePath, config.csv);
  }

  throw new Error(`Unsupported lead source: ${source}`);
}

module.exports = {
  fetchLeadsFromGooglePlaces,
  loadLeadsFromCsv,
  getQualifiedLeads,
};
