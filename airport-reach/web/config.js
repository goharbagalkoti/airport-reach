/* Runtime configuration. aws/deploy.sh overwrites this file with your real values.
 *
 * With region + apiKey set, the app uses Amazon Location Service for the basemap,
 * place search (geocoding) and driving routes. Left empty, it still runs: plain
 * dark canvas (or OpenStreetMap tiles with basemap: 'osm'), local search, and
 * straight-line distances.
 *
 * The Amazon Location API key is meant for browsers, but restrict it to your
 * site's referer and to the three APIs used here (the CloudFormation template does).
 */
window.AIRPORT_REACH_CONFIG = {
  region: '',            // e.g. 'us-east-1'
  apiKey: '',            // Amazon Location API key value (v1.public.…)
  mapStyle: 'Standard',  // Standard | Monochrome | Hybrid | Satellite
  colorScheme: 'Dark',   // Dark | Light
  basemap: 'plain'       // used only when no Amazon key is set: 'plain' | 'osm'
};
