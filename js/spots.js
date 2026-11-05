// Curated surf breaks. Coordinates mark the take-off zone (approximate);
// the model snaps every point to the nearest workable water depth anyway.
// [id, name, region, country, lat, lon]
const RAW = [
  // California
  ['mavericks', 'Mavericks', 'Half Moon Bay', 'USA', 37.4925, -122.5009],
  ['ocean-beach-sf', 'Ocean Beach', 'San Francisco', 'USA', 37.7594, -122.5107],
  ['linda-mar', 'Linda Mar', 'Pacifica', 'USA', 37.5946, -122.5021],
  ['steamer-lane', 'Steamer Lane', 'Santa Cruz', 'USA', 36.9514, -122.0262],
  ['pleasure-point', 'Pleasure Point', 'Santa Cruz', 'USA', 36.9545, -121.9714],
  ['morro-bay', 'Morro Rock', 'Morro Bay', 'USA', 35.3695, -120.8665],
  ['jalama', 'Jalama', 'Santa Barbara County', 'USA', 34.5110, -120.5025],
  ['rincon', 'Rincon', 'Santa Barbara', 'USA', 34.3735, -119.4785],
  ['zuma', 'Zuma', 'Malibu', 'USA', 34.0150, -118.8225],
  ['malibu', 'Malibu Surfrider', 'Malibu', 'USA', 34.0318, -118.6787],
  ['venice', 'Venice Breakwater', 'Los Angeles', 'USA', 33.9850, -118.4744],
  ['manhattan', 'Manhattan Beach', 'South Bay', 'USA', 33.8847, -118.4109],
  ['huntington', 'Huntington Pier', 'Orange County', 'USA', 33.6553, -118.0047],
  ['wedge', 'The Wedge', 'Newport Beach', 'USA', 33.5930, -117.8820],
  ['trestles', 'Lower Trestles', 'San Clemente', 'USA', 33.3826, -117.5885],
  ['oceanside', 'Oceanside Pier', 'North County SD', 'USA', 33.1934, -117.3866],
  ['swamis', "Swami's", 'Encinitas', 'USA', 33.0345, -117.2925],
  ['blacks', "Black's Beach", 'La Jolla', 'USA', 32.8790, -117.2530],
  ['windansea', 'Windansea', 'La Jolla', 'USA', 32.8296, -117.2814],
  ['ob-sd', 'Ocean Beach', 'San Diego', 'USA', 32.7495, -117.2550],
  // Pacific Northwest / Canada
  ['short-sands', 'Short Sands', 'Oregon', 'USA', 45.7590, -123.9640],
  ['westport', 'Westport', 'Washington', 'USA', 46.9010, -124.1250],
  ['cox-bay', 'Cox Bay', 'Tofino', 'Canada', 49.1010, -125.8790],
  // Hawaii
  ['pipeline', 'Pipeline', "North Shore O'ahu", 'USA', 21.6650, -158.0530],
  ['sunset', 'Sunset Beach', "North Shore O'ahu", 'USA', 21.6790, -158.0420],
  ['waimea', 'Waimea Bay', "North Shore O'ahu", 'USA', 21.6420, -158.0660],
  ['haleiwa', "Hale'iwa", "North Shore O'ahu", 'USA', 21.5960, -158.1080],
  ['makaha', 'Makaha', "West O'ahu", 'USA', 21.4730, -158.2210],
  ['ala-moana', 'Ala Moana Bowls', "South Shore O'ahu", 'USA', 21.2870, -157.8480],
  ['queens', "Queen's", 'Waikiki', 'USA', 21.2700, -157.8270],
  ['honolua', 'Honolua Bay', 'Maui', 'USA', 21.0150, -156.6390],
  ['jaws', "Pe'ahi (Jaws)", 'Maui', 'USA', 20.9420, -156.2970],
  ['hanalei', 'Hanalei Bay', "Kaua'i", 'USA', 22.2150, -159.5000],
  // US East Coast
  ['ditch-plains', 'Ditch Plains', 'Montauk', 'USA', 41.0390, -71.9170],
  ['narragansett', 'Narragansett Town Beach', 'Rhode Island', 'USA', 41.4330, -71.4550],
  ['rockaway', 'Rockaway Beach', 'New York City', 'USA', 40.5830, -73.8150],
  ['manasquan', 'Manasquan Inlet', 'New Jersey', 'USA', 40.1030, -74.0330],
  ['hatteras', 'Cape Hatteras Lighthouse', 'Outer Banks', 'USA', 35.2510, -75.5150],
  ['wrightsville', 'Wrightsville Beach', 'North Carolina', 'USA', 34.2100, -77.7900],
  ['folly', 'Folly Beach Washout', 'South Carolina', 'USA', 32.6580, -79.9180],
  ['new-smyrna', 'New Smyrna Inlet', 'Florida', 'USA', 29.0700, -80.9140],
  ['cocoa', 'Cocoa Beach Pier', 'Florida', 'USA', 28.3680, -80.6000],
  ['sebastian', 'Sebastian Inlet', 'Florida', 'USA', 27.8600, -80.4460],
  // Mexico / Central America / Caribbean
  ['todos-santos', 'Killers, Todos Santos', 'Baja California', 'Mexico', 31.8100, -116.8080],
  ['scorpion-bay', 'Scorpion Bay', 'Baja California Sur', 'Mexico', 26.2560, -112.4800],
  ['sayulita', 'Sayulita', 'Nayarit', 'Mexico', 20.8690, -105.4420],
  ['puerto-escondido', 'Zicatela', 'Puerto Escondido', 'Mexico', 15.8540, -97.0600],
  ['punta-roca', 'Punta Roca', 'La Libertad', 'El Salvador', 13.4880, -89.3830],
  ['popoyo', 'Popoyo', 'Rivas', 'Nicaragua', 11.4570, -86.1250],
  ['tamarindo', 'Tamarindo', 'Guanacaste', 'Costa Rica', 10.2990, -85.8420],
  ['santa-teresa', 'Santa Teresa', 'Nicoya', 'Costa Rica', 9.6430, -85.1690],
  ['playa-hermosa-cr', 'Playa Hermosa', 'Jacó', 'Costa Rica', 9.5580, -84.5800],
  ['pavones', 'Pavones', 'Golfo Dulce', 'Costa Rica', 8.3920, -83.1400],
  ['rincon-pr', 'Domes', 'Rincón', 'Puerto Rico', 18.3570, -67.2690],
  ['soup-bowl', 'Soup Bowl', 'Bathsheba', 'Barbados', 13.2140, -59.5220],
  // South America
  ['montanita', 'Montañita', 'Santa Elena', 'Ecuador', -1.8250, -80.7540],
  ['chicama', 'Chicama', 'La Libertad', 'Peru', -7.7050, -79.4450],
  ['punta-de-lobos', 'Punta de Lobos', 'Pichilemu', 'Chile', -34.4280, -72.0450],
  ['saquarema', 'Itaúna', 'Saquarema', 'Brazil', -22.9330, -42.4930],
  ['joaquina', 'Joaquina', 'Florianópolis', 'Brazil', -27.6290, -48.4490],
  // Europe
  ['thurso', 'Thurso East', 'Caithness', 'Scotland', 58.5970, -3.5090],
  ['fistral', 'Fistral', 'Newquay', 'England', 50.4160, -5.1000],
  ['croyde', 'Croyde', 'North Devon', 'England', 51.1300, -4.2420],
  ['bundoran', 'The Peak', 'Bundoran', 'Ireland', 54.4790, -8.2810],
  ['mullaghmore', 'Mullaghmore Head', 'Sligo', 'Ireland', 54.4690, -8.4500],
  ['lahinch', 'Lahinch', 'Clare', 'Ireland', 52.9330, -9.3500],
  ['klitmoller', 'Klitmøller', 'Cold Hawaii', 'Denmark', 57.0420, 8.4840],
  ['unstad', 'Unstad', 'Lofoten', 'Norway', 68.2660, 13.5820],
  ['lacanau', 'Lacanau', 'Gironde', 'France', 45.0010, -1.2050],
  ['hossegor', 'La Gravière', 'Hossegor', 'France', 43.6740, -1.4440],
  ['biarritz', 'Grande Plage', 'Biarritz', 'France', 43.4840, -1.5600],
  ['mundaka', 'Mundaka', 'Basque Country', 'Spain', 43.4080, -2.6980],
  ['zarautz', 'Zarautz', 'Basque Country', 'Spain', 43.2870, -2.1720],
  ['supertubos', 'Supertubos', 'Peniche', 'Portugal', 39.3450, -9.3620],
  ['nazare', 'Praia do Norte', 'Nazaré', 'Portugal', 39.6050, -9.0850],
  ['ericeira', "Ribeira d'Ilhas", 'Ericeira', 'Portugal', 38.9880, -9.4210],
  ['carcavelos', 'Carcavelos', 'Lisbon', 'Portugal', 38.6780, -9.3370],
  ['jardim-do-mar', 'Jardim do Mar', 'Madeira', 'Portugal', 32.7380, -17.2120],
  ['el-quemao', 'El Quemao', 'Lanzarote', 'Spain', 29.1140, -13.6600],
  // Africa
  ['safi', 'Safi', 'Marrakesh-Safi', 'Morocco', 32.3170, -9.2560],
  ['imsouane', 'Imsouane', 'Souss-Massa', 'Morocco', 30.8410, -9.8230],
  ['anchor-point', 'Anchor Point', 'Taghazout', 'Morocco', 30.5450, -9.7240],
  ['ouakam', 'Ouakam', 'Dakar', 'Senegal', 14.7230, -17.4960],
  ['elands-bay', 'Elands Bay', 'Western Cape', 'South Africa', -32.3110, 18.3330],
  ['muizenberg', 'Muizenberg', 'Cape Town', 'South Africa', -34.1080, 18.4710],
  ['jbay', 'Supertubes', "Jeffreys Bay", 'South Africa', -34.0310, 24.9310],
  ['durban', 'New Pier', 'Durban', 'South Africa', -29.8580, 31.0380],
  ['tofinho', 'Tofinho', 'Inhambane', 'Mozambique', -23.8590, 35.5470],
  ['saint-leu', 'Saint-Leu', 'Réunion', 'France', -21.1700, 55.2840],
  // Indian Ocean / Asia
  ['arugam', 'Main Point', 'Arugam Bay', 'Sri Lanka', 6.8380, 81.8380],
  ['hiriketiya', 'Hiriketiya', 'Southern Province', 'Sri Lanka', 5.9640, 80.7080],
  ['weligama', 'Weligama', 'Southern Province', 'Sri Lanka', 5.9720, 80.4290],
  ['lagundri', 'Lagundri Bay', 'Nias', 'Indonesia', 0.5620, 97.7400],
  ['uluwatu', 'Uluwatu', 'Bali', 'Indonesia', -8.8150, 115.0880],
  ['padang', 'Padang Padang', 'Bali', 'Indonesia', -8.8110, 115.1010],
  ['canggu', 'Echo Beach', 'Canggu, Bali', 'Indonesia', -8.6550, 115.1240],
  ['kuta', 'Kuta Beach', 'Bali', 'Indonesia', -8.7200, 115.1680],
  ['keramas', 'Keramas', 'Bali', 'Indonesia', -8.5830, 115.4450],
  ['g-land', 'G-Land', 'East Java', 'Indonesia', -8.7400, 114.3500],
  ['desert-point', 'Desert Point', 'Lombok', 'Indonesia', -8.7470, 115.8260],
  ['cloud-9', 'Cloud 9', 'Siargao', 'Philippines', 9.8130, 126.1660],
  ['kugenuma', 'Kugenuma', 'Shonan', 'Japan', 35.3150, 139.4730],
  ['ichinomiya', 'Ichinomiya', 'Chiba', 'Japan', 35.3600, 140.4040],
  // Pacific
  ['teahupoo', "Teahupo'o", 'Tahiti', 'French Polynesia', -17.8680, -149.2570],
  ['cloudbreak', 'Cloudbreak', 'Tavarua', 'Fiji', -17.8840, 177.1880],
  ['raglan', 'Manu Bay', 'Raglan', 'New Zealand', -37.8210, 174.8150],
  ['piha', 'Piha', 'Auckland', 'New Zealand', -36.9550, 174.4660],
  ['mount-maunganui', 'Mount Maunganui', 'Bay of Plenty', 'New Zealand', -37.6340, 176.1720],
  ['wainui', 'Wainui', 'Gisborne', 'New Zealand', -38.6900, 178.0750],
  // Australia
  ['noosa', 'First Point', 'Noosa', 'Australia', -26.3880, 153.0910],
  ['snapper', 'Snapper Rocks', 'Gold Coast', 'Australia', -28.1630, 153.5500],
  ['kirra', 'Kirra', 'Gold Coast', 'Australia', -28.1670, 153.5250],
  ['burleigh', 'Burleigh Heads', 'Gold Coast', 'Australia', -28.0880, 153.4560],
  ['byron', 'The Pass', 'Byron Bay', 'Australia', -28.6380, 153.6290],
  ['manly', 'Manly', 'Sydney', 'Australia', -33.7970, 151.2890],
  ['bondi', 'Bondi', 'Sydney', 'Australia', -33.8910, 151.2780],
  ['bells', 'Bells Beach', 'Torquay', 'Australia', -38.3700, 144.2820],
  ['shipstern', 'Shipstern Bluff', 'Tasmania', 'Australia', -43.2140, 147.7330],
  ['margaret-river', 'Main Break', 'Margaret River', 'Australia', -33.9750, 114.9850],
];

export const SPOTS = RAW.map(([id, name, region, country, lat, lon]) => ({ id, name, region, country, lat, lon }));
export const SPOT_BY_ID = new Map(SPOTS.map((s) => [s.id, s]));

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function searchSpots(q, limit = 6) {
  const t = fold(q.trim());
  if (!t) return [];
  const scored = [];
  for (const s of SPOTS) {
    const name = fold(s.name), hay = fold(`${s.name} ${s.region} ${s.country}`);
    let score = -1;
    if (name.startsWith(t)) score = 3;
    else if (name.includes(t)) score = 2;
    else if (hay.includes(t)) score = 1;
    else if (t.split(/\s+/).every((w) => hay.includes(w))) score = 0.5;
    if (score >= 0) scored.push([score, s]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}

export function haversineKm(a, b) {
  const toR = Math.PI / 180, dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function nearestSpots(p, n = 8) {
  return SPOTS.map((s) => ({ s, d: haversineKm(p, s) })).sort((a, b) => a.d - b.d).slice(0, n);
}
