import { Actor, log } from 'apify';
import got from 'got';
import unzipper from 'unzipper';
import { parse } from 'csv-parse';

await Actor.init();

const input = (await Actor.getInput()) || {};

// Normalizes list-type inputs: splits any comma-packed strings, trims whitespace, drops empties.
function normalizeList(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .flatMap((item) => String(item).split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const {
  snapshotMonth = 'latest',
  incorporatedSince = '',
  incorporatedBefore = '',
  maxResults = 500,
  logEveryNRows = 100000,
  enrichWithOfficers = true,
  enrichWithPhone = true,
  nameContains: nameContainsRaw = '',
} = input;

const companyStatuses = normalizeList(input.companyStatuses).map((s) => s.toUpperCase());
const sicCodePrefixes = normalizeList(input.sicCodePrefixes);
const sicKeywords = normalizeList(input.sicKeywords);
const postTowns = normalizeList(input.postTowns).map((s) => s.toUpperCase());
const postCodePrefixes = normalizeList(input.postCodePrefixes).map((s) => s.toUpperCase());
const counties = normalizeList(input.counties).map((s) => s.toUpperCase());
const countries = normalizeList(input.countries).map((s) => s.toUpperCase());
const companyCategories = normalizeList(input.companyCategories).map((s) => s.toUpperCase());
const nameContains = String(nameContainsRaw || '').trim().toUpperCase();

const CH_API_KEY = process.env.CH_API_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

log.info('UK Companies House Bulk Snapshot Scraper');
log.info(`   Snapshot month       : ${snapshotMonth}`);
log.info(`   SIC code prefixes    : ${sicCodePrefixes.join(', ') || '(any)'}`);
log.info(`   SIC keywords         : ${sicKeywords.join(', ') || '(any)'}`);
log.info(`   Name contains        : ${nameContains || '(any)'}`);
log.info(`   Statuses             : ${companyStatuses.join(', ') || '(any)'}`);
log.info(`   Post towns           : ${postTowns.join(', ') || '(any)'}`);
log.info(`   Postcode prefixes    : ${postCodePrefixes.join(', ') || '(any)'}`);
log.info(`   Counties             : ${counties.join(', ') || '(any)'}`);
log.info(`   Countries            : ${countries.join(', ') || '(any)'}`);
log.info(`   Company categories   : ${companyCategories.join(', ') || '(any)'}`);
log.info(`   Incorporated since   : ${incorporatedSince || '(any)'}`);
log.info(`   Incorporated before  : ${incorporatedBefore || '(any)'}`);
log.info(`   Max results          : ${maxResults}`);
log.info(`   Enrich with officers : ${enrichWithOfficers}`);
log.info(`   Enrich with phone    : ${enrichWithPhone}`);

if (enrichWithOfficers && !CH_API_KEY) {
  log.warning('enrichWithOfficers is true but CH_API_KEY environment variable is not set. Skipping that step.');
}
if (enrichWithPhone && !GOOGLE_PLACES_API_KEY) {
  log.warning('enrichWithPhone is true but GOOGLE_PLACES_API_KEY environment variable is not set. Skipping that step.');
}

// ---------------------------------------------------------------------------
// 1. Discover available snapshot(s) from the Companies House listing page
// ---------------------------------------------------------------------------
async function discoverSnapshots() {
  const listUrl = 'https://download.companieshouse.gov.uk/en_output.html';
  log.info(`Discovering snapshot from ${listUrl}`);

  const html = await got(listUrl).text();
  const matches = [...html.matchAll(/BasicCompanyDataAsOneFile-(\d{4}-\d{2}-\d{2})\.zip/g)];
  const dates = [...new Set(matches.map((m) => m[1]))].sort();

  if (!dates.length) {
    throw new Error('Could not find any BasicCompanyDataAsOneFile snapshot links on the page.');
  }

  log.info(`Found ${dates.length} snapshot date(s): ${dates.join(', ')}`);

  return dates.map((date) => ({
    date,
    url: `https://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-${date}.zip`,
  }));
}

async function findSnapshot(requestedMonth) {
  const snapshots = await discoverSnapshots();
  const latest = snapshots[snapshots.length - 1];

  if (!requestedMonth || requestedMonth === 'latest') {
    return latest;
  }

  const match = snapshots.find((s) => s.date.startsWith(requestedMonth));
  if (!match) {
    log.warning(
      `Requested snapshot "${requestedMonth}" not found. Companies House only keeps the ` +
      `current month's file available. Falling back to latest: ${latest.date}`
    );
    return latest;
  }
  return match;
}

// ---------------------------------------------------------------------------
// 2. Row filtering logic
// ---------------------------------------------------------------------------
function matchesFilters(row) {
  const status = (row['CompanyStatus'] || '').toUpperCase();
  const incDate = row['IncorporationDate'] || '';
  const town = (row['RegAddress.PostTown'] || '').toUpperCase();
  const postcode = (row['RegAddress.PostCode'] || '').toUpperCase();
  const county = (row['RegAddress.County'] || '').toUpperCase();
  const country = (row['RegAddress.Country'] || row['CountryOfOrigin'] || '').toUpperCase();
  const category = (row['CompanyCategory'] || '').toUpperCase();
  const name = (row['CompanyName'] || '').toUpperCase();

  const sicText = [
    row['SICCode.SicText_1'],
    row['SICCode.SicText_2'],
    row['SICCode.SicText_3'],
    row['SICCode.SicText_4'],
  ]
    .filter(Boolean)
    .join(' | ');

  if (companyStatuses.length && !companyStatuses.includes(status)) return false;

  if (incorporatedSince && incDate && incDate < incorporatedSince) return false;
  if (incorporatedBefore && incDate && incDate > incorporatedBefore) return false;

  if (postTowns.length && !postTowns.includes(town)) return false;

  if (postCodePrefixes.length && !postCodePrefixes.some((p) => postcode.startsWith(p))) return false;

  if (counties.length && !counties.includes(county)) return false;

  if (countries.length && country && !countries.includes(country)) return false;

  if (companyCategories.length && !companyCategories.includes(category)) return false;

  if (nameContains && !name.includes(nameContains)) return false;

  if (sicCodePrefixes.length) {
    const sicCodes = [
      row['SICCode.SicText_1'],
      row['SICCode.SicText_2'],
      row['SICCode.SicText_3'],
      row['SICCode.SicText_4'],
    ].filter(Boolean);
    const codeMatch = sicCodes.some((codeText) =>
      sicCodePrefixes.some((prefix) => codeText.startsWith(prefix))
    );
    if (!codeMatch) return false;
  }

  if (sicKeywords.length) {
    const keywordMatch = sicKeywords.some((kw) => sicText.toLowerCase().includes(kw.toLowerCase()));
    if (!keywordMatch) return false;
  }

  return true;
}

function mapRowToOutput(row) {
  return {
    companyName: row['CompanyName'],
    companyNumber: row['CompanyNumber'],
    companyStatus: row['CompanyStatus'],
    companyCategory: row['CompanyCategory'],
    incorporationDate: row['IncorporationDate'],
    sicCodes: [
      row['SICCode.SicText_1'],
      row['SICCode.SicText_2'],
      row['SICCode.SicText_3'],
      row['SICCode.SicText_4'],
    ].filter(Boolean),
    address: {
      careOf: row['RegAddress.CareOf'],
      poBox: row['RegAddress.POBox'],
      addressLine1: row['RegAddress.AddressLine1'],
      addressLine2: row['RegAddress.AddressLine2'],
      postTown: row['RegAddress.PostTown'],
      county: row['RegAddress.County'],
      country: row['RegAddress.Country'],
      postCode: row['RegAddress.PostCode'],
    },
    officers: [],
    personsWithSignificantControl: [],
    phoneNumber: null,
    website: null,
    googlePlaceName: null,
  };
}

// ---------------------------------------------------------------------------
// 3. Stream download -> unzip -> parse CSV -> filter -> collect matches
// ---------------------------------------------------------------------------
async function processSnapshot(url) {
  let rowCount = 0;
  let matchCount = 0;
  const matches = [];

  return new Promise((resolve, reject) => {
    const httpStream = got.stream(url);

    httpStream.on('error', (err) => reject(new Error(`Download failed: ${err.message}`)));

    httpStream
      .pipe(unzipper.ParseOne(/\.csv$/i))
      .on('error', (err) => reject(new Error(`Unzip failed: ${err.message}`)))
      .pipe(parse({ columns: true, skip_empty_lines: true, relax_column_count: true }))
      .on('data', (row) => {
        rowCount += 1;

        if (logEveryNRows && rowCount % logEveryNRows === 0) {
          log.info(`Processed ${rowCount} rows, ${matchCount} matches so far...`);
        }

        if (matchCount >= maxResults) return;

        if (matchesFilters(row)) {
          matches.push(mapRowToOutput(row));
          matchCount += 1;

          if (matchCount >= maxResults) {
            log.info(`Reached maxResults (${maxResults}). Stopping early.`);
            httpStream.destroy();
          }
        }
      })
      .on('end', () => {
        log.info(`Filtering done. Scanned ${rowCount} rows, matched ${matchCount} companies.`);
        resolve(matches);
      })
      .on('error', (err) => reject(new Error(`CSV parse failed: ${err.message}`)));
  });
}

// ---------------------------------------------------------------------------
// 4. Enrichment: Companies House officers + PSC
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOfficers(companyNumber) {
  try {
    const res = await got(
      `https://api.company-information.service.gov.uk/company/${companyNumber}/officers`,
      { username: CH_API_KEY, password: '', responseType: 'json', throwHttpErrors: false }
    );
    if (res.statusCode !== 200) return [];
    const items = res.body.items || [];
    return items
      .filter((o) => !o.resigned_on)
      .map((o) => ({
        name: o.name,
        role: o.officer_role,
        appointedOn: o.appointed_on,
        nationality: o.nationality,
        occupation: o.occupation,
      }));
  } catch (err) {
    log.warning(`Officers fetch failed for ${companyNumber}: ${err.message}`);
    return [];
  }
}

async function fetchPSC(companyNumber) {
  try {
    const res = await got(
      `https://api.company-information.service.gov.uk/company/${companyNumber}/persons-with-significant-control`,
      { username: CH_API_KEY, password: '', responseType: 'json', throwHttpErrors: false }
    );
    if (res.statusCode !== 200) return [];
    const items = res.body.items || [];
    return items.map((p) => ({
      name: p.name,
      kind: p.kind,
      nationality: p.nationality,
      naturesOfControl: p.natures_of_control,
    }));
  } catch (err) {
    log.warning(`PSC fetch failed for ${companyNumber}: ${err.message}`);
    return [];
  }
}

async function enrichWithCompaniesHouse(companies) {
  const DELAY_MS = 350;
  let processed = 0;

  for (const company of companies) {
    const [officers, psc] = await Promise.all([
      fetchOfficers(company.companyNumber),
      fetchPSC(company.companyNumber),
    ]);
    company.officers = officers;
    company.personsWithSignificantControl = psc;

    processed += 1;
    if (processed % 25 === 0) {
      log.info(`CH enrichment: ${processed}/${companies.length} companies...`);
    }

    await sleep(DELAY_MS);
  }

  return companies;
}

// ---------------------------------------------------------------------------
// 5. Enrichment: Google Places phone number + website
// ---------------------------------------------------------------------------
async function findPlace(query) {
  try {
    const searchRes = await got('https://maps.googleapis.com/maps/api/place/findplacefromtext/json', {
      searchParams: {
        input: query,
        inputtype: 'textquery',
        fields: 'place_id,name',
        key: GOOGLE_PLACES_API_KEY,
      },
      responseType: 'json',
      throwHttpErrors: false,
    });

    const candidates = searchRes.body && searchRes.body.candidates ? searchRes.body.candidates : [];
    if (!candidates.length) return null;

    const placeId = candidates[0].place_id;

    const detailsRes = await got('https://maps.googleapis.com/maps/api/place/details/json', {
      searchParams: {
        place_id: placeId,
        fields: 'name,formatted_phone_number,international_phone_number,website',
        key: GOOGLE_PLACES_API_KEY,
      },
      responseType: 'json',
      throwHttpErrors: false,
    });

    const result = detailsRes.body ? detailsRes.body.result : null;
    if (!result) return null;

    return {
      googlePlaceName: result.name || null,
      phoneNumber: result.formatted_phone_number || result.international_phone_number || null,
      website: result.website || null,
    };
  } catch (err) {
    log.warning(`Google Places lookup failed for "${query}": ${err.message}`);
    return null;
  }
}

async function enrichWithGooglePlaces(companies) {
  const DELAY_MS = 150;
  let processed = 0;
  let foundCount = 0;

  for (const company of companies) {
    const town = company.address.postTown || '';
    const query = `${company.companyName} ${town} UK`.trim();

    const place = await findPlace(query);
    if (place) {
      company.googlePlaceName = place.googlePlaceName;
      company.phoneNumber = place.phoneNumber;
      company.website = place.website;
      if (place.phoneNumber) foundCount += 1;
    }

    processed += 1;
    if (processed % 25 === 0) {
      log.info(`Google Places enrichment: ${processed}/${companies.length} companies, ${foundCount} phone numbers found so far...`);
    }

    await sleep(DELAY_MS);
  }

  log.info(`Google Places enrichment done. Found phone numbers for ${foundCount}/${companies.length} companies.`);
  return companies;
}

// ---------------------------------------------------------------------------
// 6. Run
// ---------------------------------------------------------------------------
try {
  const snapshot = await findSnapshot(snapshotMonth);
  log.info(`Using snapshot: ${snapshot.date} (${snapshot.url})`);

  const matches = await processSnapshot(snapshot.url);

  let finalResults = matches;

  if (enrichWithOfficers && CH_API_KEY) {
    log.info(`Enriching ${matches.length} companies with officer and PSC data (this may take a while)...`);
    finalResults = await enrichWithCompaniesHouse(finalResults);
  }

  if (enrichWithPhone && GOOGLE_PLACES_API_KEY) {
    log.info(`Looking up ${finalResults.length} companies on Google Places for phone and website (this may take a while)...`);
    finalResults = await enrichWithGooglePlaces(finalResults);
  }

  await Actor.pushData(finalResults);
  log.info(`Done. Pushed ${finalResults.length} companies to the dataset.`);
} catch (err) {
  log.error(`Failed: ${err.message}`);
  throw err;
}

await Actor.exit();
