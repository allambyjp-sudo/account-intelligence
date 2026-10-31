import type { TechCategory } from "@/lib/domain/enums";

/**
 * Website tech footprint: vendors visible in a company's public pages (script sources, sign-in
 * links, meta generator). Deterministic and cheap; the model never has to guess these. Each hit
 * becomes a tech stack item with evidence "web_footprint". Visible on the website is good evidence
 * for the website's own stack, weaker for the wider estate, so confidence is medium at most.
 */
export interface FootprintRule {
  vendor: string;
  product: string;
  category: TechCategory;
  pattern: RegExp;
}

export const FOOTPRINT_RULES: FootprintRule[] = [
  { vendor: "Microsoft", product: "Entra ID (sign-in)", category: "identity", pattern: /login\.microsoftonline\.com/i },
  { vendor: "Microsoft", product: "Azure CDN / Front Door", category: "cloud", pattern: /\.azureedge\.net|\.azurefd\.net/i },
  { vendor: "Microsoft", product: "Azure App Service", category: "cloud", pattern: /\.azurewebsites\.net/i },
  { vendor: "Microsoft", product: "Dynamics 365", category: "crm", pattern: /\.dynamics\.com|\.crm6\.dynamics\.com/i },
  { vendor: "Microsoft", product: "SharePoint", category: "productivity", pattern: /\.sharepoint\.com/i },
  { vendor: "Microsoft", product: "Clarity", category: "data", pattern: /clarity\.ms/i },
  { vendor: "AWS", product: "CloudFront", category: "cloud", pattern: /\.cloudfront\.net/i },
  { vendor: "AWS", product: "S3", category: "cloud", pattern: /\.s3[.-][a-z0-9-]*\.?amazonaws\.com|s3\.amazonaws\.com/i },
  { vendor: "Google", product: "Tag Manager", category: "data", pattern: /googletagmanager\.com\/gtm\.js/i },
  { vendor: "Google", product: "Analytics", category: "data", pattern: /google-analytics\.com|googletagmanager\.com\/gtag\/js/i },
  { vendor: "Google", product: "Cloud Storage", category: "cloud", pattern: /storage\.googleapis\.com/i },
  { vendor: "Cloudflare", product: "CDN", category: "network", pattern: /cdnjs\.cloudflare\.com|cloudflareinsights\.com|\/cdn-cgi\//i },
  { vendor: "Akamai", product: "CDN", category: "network", pattern: /akamaihd\.net|akamaized\.net/i },
  { vendor: "Okta", product: "Okta", category: "identity", pattern: /\.okta\.com|\.oktacdn\.com/i },
  { vendor: "Salesforce", product: "Salesforce", category: "crm", pattern: /\.force\.com|\.salesforce\.com|\.my\.site\.com/i },
  { vendor: "Salesforce", product: "Marketing Cloud", category: "crm", pattern: /\.exacttarget\.com|\.marketingcloudapis\.com/i },
  { vendor: "HubSpot", product: "HubSpot", category: "crm", pattern: /hs-scripts\.com|hsforms\.net|hubspot\.com/i },
  { vendor: "Adobe", product: "Experience Cloud", category: "data", pattern: /adobedtm\.com|omtrdc\.net|demdex\.net/i },
  { vendor: "ServiceNow", product: "ServiceNow", category: "other", pattern: /\.service-now\.com/i },
  { vendor: "Zendesk", product: "Zendesk", category: "crm", pattern: /zdassets\.com|\.zendesk\.com/i },
  { vendor: "Workday", product: "Workday", category: "erp", pattern: /\.myworkdayjobs\.com|\.workday\.com/i },
  { vendor: "SAP", product: "SuccessFactors", category: "erp", pattern: /successfactors\.(com|eu)|\.sapsf\.com/i },
  { vendor: "Oracle", product: "Taleo / Recruiting Cloud", category: "erp", pattern: /taleo\.net|\.oraclecloud\.com/i },
  { vendor: "PageUp", product: "PageUp", category: "erp", pattern: /pageuppeople\.com/i },
  { vendor: "Atlassian", product: "Atlassian Cloud", category: "devops", pattern: /\.atlassian\.net/i },
  { vendor: "Shopify", product: "Shopify", category: "other", pattern: /cdn\.shopify\.com|myshopify\.com/i },
  { vendor: "WordPress", product: "WordPress", category: "other", pattern: /\/wp-content\/|\/wp-includes\/|generator:wordpress/i },
  { vendor: "Drupal", product: "Drupal", category: "other", pattern: /\/sites\/default\/files\/|drupal\.js|generator:drupal/i },
  { vendor: "Sitecore", product: "Sitecore", category: "other", pattern: /\/-\/media\/|sitecore|generator:sitecore/i },
  { vendor: "Adobe", product: "Experience Manager", category: "other", pattern: /\/etc\.clientlibs\/|\/content\/dam\//i },
  { vendor: "Genesys", product: "Genesys Cloud", category: "crm", pattern: /mypurecloud\.com|genesys\.com\/widgets/i },
  { vendor: "Zscaler", product: "Zscaler", category: "security", pattern: /zscaler/i },
];

export interface FootprintHit {
  vendor: string;
  product: string;
  category: TechCategory;
  /** The marker that matched, kept short so it can be shown as evidence. */
  evidence: string;
}

export function detectFootprint(markers: Array<string | null | undefined>, generator?: string | null): FootprintHit[] {
  const hits = new Map<string, FootprintHit>();
  const all = [...markers.filter((m): m is string => Boolean(m)), ...(generator ? [`generator:${generator}`] : [])];
  for (const rule of FOOTPRINT_RULES) {
    const marker = all.find((m) => rule.pattern.test(m));
    if (!marker) continue;
    const key = `${rule.vendor}|${rule.product}`;
    if (!hits.has(key)) {
      const m = rule.pattern.exec(marker);
      hits.set(key, { vendor: rule.vendor, product: rule.product, category: rule.category, evidence: (m?.[0] ?? marker).slice(0, 120) });
    }
  }
  return [...hits.values()];
}
