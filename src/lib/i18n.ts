"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/** Native English ⇄ አማርኛ language layer.  It is deliberately local-first:
 * no third-party script ever rewrites React-owned nodes, form values, or order
 * data — Google's engine runs SERVER-side (/api/translate) and only sends back
 * plain strings, so the menu UI can never be damaged by translation.
 *
 * Translation tiers (first match wins):
 *   1. STRINGS / MENU_AM / CATEGORY_AM — hand-tuned dictionaries, instant & offline
 *   2. Google auto-translation of ANY other text (owner-added menu items,
 *      categories, announcements, settings texts) — cached in localStorage +
 *      the `translations` DB table, so it is instant after the first time. */

export type Lang = "en" | "am";

const STORAGE_KEY = "fana_lang";

/* ───────────────────────── persistence ───────────────────────── */

export function getLang(): Lang {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "am" || saved === "en") return saved;
  } catch {}
  return "en";
}

const LANG_EVENT = "fana-lang-change";

export function setLang(lang: Lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {}
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
  }
  // Same-tab listeners (storage events only fire in OTHER tabs).
  window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang }));
}

function subscribeLang(cb: () => void) {
  window.addEventListener(LANG_EVENT, cb);
  window.addEventListener("storage", cb); // other tabs
  return () => {
    window.removeEventListener(LANG_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

const serverSnapshot: Lang = "en";

/** Reactive hook: [lang, changeLang]. Syncs across every open tab. */
export function useLang(): [Lang, (l: Lang) => void] {
  const lang = useSyncExternalStore(subscribeLang, getLang, () => serverSnapshot);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const change = useCallback((l: Lang) => {
    setLang(l);
  }, []);

  return [lang, change];
}

/* ───────────────────────── dictionaries ───────────────────────── */

const STRINGS = {
  en: {
    /* customer menu — loading / chrome */
    menu_label: "Menu",
    loading_menu: "Loading menu...",
    loading_sub: "Your table's dishes are on the way ☕",
    intro: "Pick your items, add notes, then Submit Order — your waiter will confirm at your table.",
    search_ph: "Search drinks, meals, pastries...",
    waiter: "Waiter",

    /* customer menu — items */
    add: "Add",
    details: "Details",
    out_of_stock: "Out of Stock",
    description: "Description",
    add_to_order: "Add to Order",
    sale: "SALE",
    you_save: "You save",
    until: "until",
    nothing_found: "Nothing found in this category — please ask a waiter if the menu looks incomplete.",

    /* customer menu — cart & submit */
    review_order: "Review Order",
    review_your_order: "Review Your Order",
    submit_order: "Submit Order",
    sending: "Sending...",
    remove: "Remove",
    note_ph: "📝 Note: No Sugar, Less Ice, Extra Mayo...",
    items_label: "item(s)",
    err_submit: "Could not submit order. Please call your waiter.",
    err_connection: "Connection issue — press Submit again. Your order will NOT be sent twice.",
    err_menu_updated: "The menu was just updated — please re-add your items and submit again.",

    /* customer menu — confirmation */
    order_sent_title: "Order Request Sent!",
    waiting_confirmation: "Waiting for Waiter Confirmation",
    waiter_walking:
      "Your waiter is walking to {table} to confirm your order. Once confirmed, preparation starts immediately.",
    add_more_note: "Want to add more? You can order again anytime — it joins your table's bill automatically.",
    back_to_menu: "← Back to Menu",

    /* customer menu — no table */
    scan_qr_title: "Scan a Table QR Code",
    scan_qr_sub: "Please scan the QR code on your table to open your table's ordering menu.",

    /* customer menu — content sections */
    about_us: "☕ About Us",
    gallery: "Gallery",
    what_we_serve: "✨ What We Serve",
    premium_coffee: "☕ Premium Coffee",
    ethiopian_meals: "🍽 Ethiopian Meals",
    fresh_pastries: "🥐 Fresh Pastries",
    fresh_juices: "🥤 Fresh Juices",
    find_us: "Find Us",
    open_maps: "Open in Google Maps →",
    what_guests_say: "What Guests Say",
    leave_review: "Leave a Review",
    your_name_ph: "Your name",
    review_q_ph: "How was your coffee today?",
    submit_review: "Submit Review",
    reviews_note: "Reviews appear after owner approval.",
    review_need_name: "Please add your name and a short comment.",
    review_thanks: "✓ Thank you! Your review awaits admin approval before it appears.",
    review_fail: "Couldn't submit right now. Please tell a waiter.",

    /* homepage — nav */
    nav_home: "Home",
    nav_about: "About",
    nav_menu: "Menu",
    nav_services: "Services",
    nav_gallery: "Gallery",
    nav_reviews: "Reviews",
    nav_find_us: "Find Us",

    /* homepage — hero */
    hero_open_daily: "Open Daily",
    hero_cta_menu: "Explore Menu & Prices",
    hero_cta_location: "Find Us / Scan QR",
    hero_hl_brews: "Specialty Brews",
    hero_hl_macchiato: "Famous Fana Macchiato",
    hero_hl_juices: "Fresh Fruit Punches",
    hero_hl_spris: "100% Pure Spris Juice",
    hero_hl_dining: "Authentic Dining",
    hero_hl_sandwich: "Sandwiches & Beyaynet",
    hero_hl_reviews: "Google Reviews",

    /* homepage — sections */
    sec_menu: "Fresh Flavors & Specialty Brews",
    sec_why: "Crafted For Quality, Flavor & Comfort",
    sec_how: "How Service Works",
    sec_gallery: "Moments at Fana Cafe",
    sec_location: "Visit Fana Cafe at 22 Square",
    sec_faq: "Frequently Asked Questions",
    sec_reviews: "What Visitors Say About Fana Cafe",

    /* homepage — CTA banner */
    cta_badge: "Visit Fana Cafe Today",
    cta_title: "Great Taste. Comfortable Atmosphere. Memorable Moments.",
    cta_sub: "Life is better with great Ethiopian coffee, delicious freshly prepared food, and meaningful conversations.",
    cta_menu: "Explore Our Menu",
    cta_call: "Call",
    cta_find: "Find Us (22 Square)",

    /* homepage — footer */
    footer_quick_links: "Quick Links",
    fl_home: "Home",
    fl_about: "About Fana Cafe",
    fl_why: "Why Choose Us",
    fl_menu: "Full Menu & Prices",
    fl_services: "Dine-In & Delivery",
    fl_gallery: "Photo Gallery",
    footer_hours: "Opening Hours & Contact",
    footer_privacy: "Privacy Policy",
    footer_terms: "Terms of Service",
    footer_rights: "All Rights Reserved.",

    /* homepage — full menu section */
    menu_badge_full: "Our Full Menu",
    menu_browse_sub:
      "Browse our complete selection of coffee, fresh fruit juices, Ethiopian favorites, club sandwiches, pastries, and snacks. All prices listed in Ethiopian Birr (ETB).",
    search_menu_ph: "Search coffee, Spris juice, club sandwich, or desserts...",
    clear_search: "Clear",
    showing_items: "Showing {n} items",
    reset_filter: "Reset Category Filter",
    no_match_title: "No menu items match your search",
    no_match_sub: "Try clearing your search term or selecting another category.",
    show_all: "Show All Menu Items",
    sold_out: "Sold Out",
    unavailable: "Unavailable",
    prep_time_label: "Prep Time:",
    dietary_features: "Dietary & Features",
    call_waiter_order: "Call your waiter to order this item",
    includes_warmth: "Includes warm Ethiopian hospitality",

    /* homepage — reviews section */
    write_review: "Write a Review",
  },

  am: {
    /* customer menu — loading / chrome */
    menu_label: "ምናሌ",
    loading_menu: "ምናሌ በመጫን ላይ...",
    loading_sub: "የጠረጴዛዎ ምግቦች በመንገድ ላይ ናቸው ☕",
    intro: "ምርጫዎን ይምረጡ፣ ማስታወሻ ይጨምሩ፣ ትዕዛዝ ይላኩ — ሰራተኛው በጠረጴዛዎ ያረጋግጣል።",
    search_ph: "መጠጥ፣ ምግብ፣ ኬክ ፈልግ...",
    waiter: "ሰራተኛ",

    /* customer menu — items */
    add: "ጨምር",
    details: "ዝርዝር",
    out_of_stock: "አልቋል",
    description: "መግለጫ",
    add_to_order: "ወደ ትዕዛዝ ጨምር",
    sale: "ቅናሽ",
    you_save: "ቆጥበዋል",
    until: "እስከ",
    nothing_found: "በዚህ ምድብ ምንም አልተገኘም — ምናሌው ያልተሟላ ከሆነ እባክዎ ሰራተኛ ይጠይቁ።",

    /* customer menu — cart & submit */
    review_order: "ትዕዛዝ ገምግም",
    review_your_order: "ትዕዛዝዎን ይገምግሙ",
    submit_order: "ትዕዛዝ ላክ",
    sending: "በመላክ ላይ...",
    remove: "አስወግድ",
    note_ph: "📝 ማስታወሻ፡ ስኳር የለም፣ በረድ ይቀንሱ፣ ማዮ ይብዙ...",
    items_label: "እቃዎች",
    err_submit: "ትዕዛዝ መላክ አልተቻለም። እባክዎ ሰራተኛ ይጥሩ።",
    err_connection: "የግንኙነት ችግር — እንደገና ይላኩ። ትዕዛዝዎ ሁለት ጊዜ አይላክም።",
    err_menu_updated: "ምናሌው አሁን ተዘምኗል — እባክዎ ዕቃዎችዎን እንደገና ጨምረው ይላኩ።",

    /* customer menu — confirmation */
    order_sent_title: "ትዕዛዝ ተልኳል!",
    waiting_confirmation: "የሰራተኛ ማረጋገጫ በመጠበቅ ላይ",
    waiter_walking: "ሰራተኛው ትዕዛዝዎን ለማረጋገጥ ወደ {table} እየመጣ ነው። ከተረጋገጠ በኋላ ወዲያውኑ ይዘጋጃል።",
    add_more_note: "ተጨማሪ መጨመር ይፈልጋሉ? በማንኛውም ጊዜ እንደገና ማዘዝ ይችላሉ — በራስ-ሰር ከጠረጴዛዎ ሂሳብ ጋር ይጣመራል።",
    back_to_menu: "← ወደ ምናሌ ተመለስ",

    /* customer menu — no table */
    scan_qr_title: "የጠረጴዛ QR ኮድ ይቃኙ",
    scan_qr_sub: "የጠረጴዛዎን የትዕዛዝ ምናሌ ለመክፈት በጠረጴዛዎ ላይ ያለውን QR ኮድ ይቃኙ።",

    /* customer menu — content sections */
    about_us: "☕ ስለ እኛ",
    gallery: "ጋለሪ",
    what_we_serve: "✨ የምናቀርባቸው",
    premium_coffee: "☕ ምርጥ ቡና",
    ethiopian_meals: "🍽 የኢትዮጵያ ምግቦች",
    fresh_pastries: "🥐 ትኩስ ዳቦዎች",
    fresh_juices: "🥤 ትኩስ ጭማቂዎች",
    find_us: "ያግኙን",
    open_maps: "በGoogle ካርታ ይክፈቱ →",
    what_guests_say: "እንግዶች ምን ይላሉ",
    leave_review: "ግምገማ ይተው",
    your_name_ph: "ስምዎ",
    review_q_ph: "የዛሬው ቡናዎ እንዴት ነበር?",
    submit_review: "ግምገማ ላክ",
    reviews_note: "ግምገማዎች ከባለቤት ፈቃድ በኋላ ይታያሉ።",
    review_need_name: "እባክዎ ስምዎን እና አጭር አስተያየት ይጨምሩ።",
    review_thanks: "✓ እናመሰግናለን! ግምገማዎ ከመታየቱ በፊት የአስተዳዳሪ ፈቃድ ይጠብቃል።",
    review_fail: "አሁን መላክ አልተቻለም። እባክዎ ለሰራተኛ ይንገሩ።",

    /* homepage — nav */
    nav_home: "መነሻ",
    nav_about: "ስለ እኛ",
    nav_menu: "ምናሌ",
    nav_services: "አገልግሎቶች",
    nav_gallery: "ጋለሪ",
    nav_reviews: "ግምገማዎች",
    nav_find_us: "ያግኙን",

    /* homepage — hero */
    hero_open_daily: "በየቀኑ ክፍት",
    hero_cta_menu: "ምናሌ እና ዋጋዎችን ይመልከቱ",
    hero_cta_location: "ያግኙን / QR ይቃኙ",
    hero_hl_brews: "ልዩ ቡናዎች",
    hero_hl_macchiato: "ታዋቂው የፋና ማኪያቶ",
    hero_hl_juices: "ትኩስ የፍራፍሬ ጭማቂዎች",
    hero_hl_spris: "100% ንጹህ ስፕሪስ ጭማቂ",
    hero_hl_dining: "ትክክለኛ የኢትዮጵያ ምግብ",
    hero_hl_sandwich: "ሳንድዊች እና በያይነት",
    hero_hl_reviews: "የGoogle ግምገማዎች",

    /* homepage — sections */
    sec_menu: "ትኩስ ጣዕሞች እና ልዩ ቡናዎች",
    sec_why: "ለጥራት፣ ለጣዕም እና ለምቾት የተሰራ",
    sec_how: "አገልግሎት እንዴት እንደሚሰራ",
    sec_gallery: "በፋና ካፌ ያለፉ ጊዜያት",
    sec_location: "ፋና ካፌን በ22 ስኩዌር ይጎብኙ",
    sec_faq: "በተደጋጋሚ የሚጠየቁ ጥያቄዎች",
    sec_reviews: "ጎብኚዎች ስለ ፋና ካፌ የሚሉት",

    /* homepage — CTA banner */
    cta_badge: "ዛሬ ፋና ካፌን ይጎብኙ",
    cta_title: "ጣፋጭ ጣዕም። ምቹ አየር። የማይረሱ ጊዜያት።",
    cta_sub: "ሕይወት ከምርጥ የኢትዮጵያ ቡና፣ ጣፋጭ ትኩስ ምግብ እና ትርጉም ያለው ውይይት ጋር ይበልጣል።",
    cta_menu: "ምናሌያችንን ይመልከቱ",
    cta_call: "ይደውሉ",
    cta_find: "ያግኙን (22 ስኩዌር)",

    /* homepage — footer */
    footer_quick_links: "ፈጣን አገናኞች",
    fl_home: "መነሻ",
    fl_about: "ስለ ፋና ካፌ",
    fl_why: "ለምን እኛን ይመርጣሉ",
    fl_menu: "ሙሉ ምናሌ እና ዋጋዎች",
    fl_services: "በቦታው መመገብ እና ማድረስ",
    fl_gallery: "የፎቶ ጋለሪ",
    footer_hours: "የስራ ሰዓት እና አድራሻ",
    footer_privacy: "የግላዊነት ፖሊሲ",
    footer_terms: "የአገልግሎት ውሎች",
    footer_rights: "መብቱ በህግ የተጠበቀ ነው።",

    /* homepage — full menu section */
    menu_badge_full: "ሙሉ ምናሌያችን",
    menu_browse_sub:
      "የቡናዎች፣ ትኩስ የፍራፍሬ ጭማቂዎች፣ ተወዳጅ የኢትዮጵያ ምግቦች፣ ክለብ ሳንድዊቾች፣ ፓስትሪዎች እና ቀላል ምግቦች ሙሉ ምርጫ። ሁሉም ዋጋዎች በኢትዮጵያ ብር (ETB) ተዘርዘርዋል።",
    search_menu_ph: "ቡና፣ ስፕሪስ ጭማቂ፣ ክለብ ሳንድዊች ወይም ጣፋጮችን ይፈልጉ...",
    clear_search: "አጽዳ",
    showing_items: "{n} እቃዎች ተገኝተዋል",
    reset_filter: "የምድብ ማጣሪያ ዳግም አስጀምር",
    no_match_title: "ከፍለጋዎ ጋር የሚጣጣም እቃ አልተገኘም",
    no_match_sub: "ፍለጋዎን አጽደው ወይም ሌላ ምድብ ይምረጡ።",
    show_all: "ሁሉንም እቃዎች አሳይ",
    sold_out: "አልቋል",
    unavailable: "አይገኝም",
    prep_time_label: "የማብሰያ ጊዜ፡",
    dietary_features: "የአመጋገብ ልዩ ምልክቶች",
    call_waiter_order: "ይህን እቃ ለማዘዝ ሰራተኛዎን ይጥሩ",
    includes_warmth: "በሞቅ ያለ የኢትዮጵያ እንግዳ ተቀባይነትን ያካትታል",

    /* homepage — reviews section */
    write_review: "ግምገማ ጻፍ",
  },
} as const;

export type StringKey = keyof typeof STRINGS.en;

/** Translator bound to the current language. */
export function useT(): (key: StringKey, vars?: Record<string, string>) => string {
  const [lang] = useLang();
  return useCallback(
    (key: StringKey, vars?: Record<string, string>) => {
      let text: string = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
      }
      return text;
    },
    [lang]
  );
}

/** Native display translations for seeded menu data. The database's English values
 * remain canonical identifiers, so changing language never changes an order payload. */
const MENU_AM: Record<string, string> = {
  "Fana Cafe & Restaurant": "ፋና ካፌ እና ሬስቶራንት",
  "Fana Cafe": "ፋና ካፌ",
  "The Famous Fana Macchiato": "ታዋቂው የፋና ማኪያቶ",
  "Mixed Fruit Juice (Spris)": "የተቀላቀለ የፍራፍሬ ጭማቂ (ስፕሪስ)",
  "Chicken Club Sandwich": "የዶሮ ክለብ ሳንድዊች",
  "Traditional Ethiopian Beyaynet Platter": "ባህላዊ የኢትዮጵያ በያይነት",
  "Golden French Fries": "ወርቃማ ጥብስ ድንች",
  "Traditional Ethiopian Coffee (Jebena)": "ባህላዊ የኢትዮጵያ ቡና (ጀበና)",
  "Special Fruit Punches": "ልዩ የፍራፍሬ ጭማቂዎች",
  "Ethiopian Spiced Chechebsa": "የኢትዮጵያ ቅመም ያለው ጨጨብሳ",
  "Delicious Fresh Cake & Pastries": "ጣፋጭ ትኩስ ኬክ እና ፓስትሪዎች",
  "Our world-class signature layered Ethiopian macchiato brewed with rich Arabica espresso and steamed microfoam milk.": "በምርጥ የአረቢካ ኤስፕሬሶ እና ለስላሳ የወተት አረፋ የተዘጋጀ ልዩ የኢትዮጵያ ማኪያቶ።",
  "Freshly blended multi-layered puree of ripe local avocado, mango, and papaya with optional lemon squeeze.": "ከደረሱ አቮካዶ፣ ማንጎ እና ፓፓያ በትኩስ የተቀላቀለ ጭማቂ፣ እንደ ፍላጎትዎ ከሎሚ ጋር።",
  "Triple-decker layered roasted chicken breast, crispy beef bacon, melted cheddar, egg, lettuce, tomato, served with French fries.": "በሶስት ደረጃ የተደረደረ የተጠበሰ ዶሮ፣ ባኮን፣ ቼዳር አይብ፣ እንቁላል፣ ሰላጣ እና ቲማቲም፣ ከጥብስ ድንች ጋር።",
  "Generous traditional fasting platter featuring Shiro, Kik Alicha, Misir Wot, Gomen, Atakilt Wot, and fresh Injera.": "ሽሮ፣ ክክ አልጫ፣ ምስር ወጥ፣ ጎመን፣ አትክልት ወጥ እና ትኩስ እንጀራ የያዘ ባህላዊ የጾም በያይነት።",
  "Crispy skin-on golden potatoes lightly salted and served hot with tomato ketchup and house chili mayo dip.": "ቀለል ባለ ጨው የተቀመመ ትኩስ ጥብስ ድንች ከቲማቲም ኬቸፕ እና ቺሊ ማዮ ጋር።",
  "Authentic slow-brewed single-origin Arabica coffee served fresh from a traditional clay Jebena pot.": "በባህላዊ የሸክላ ጀበና ቀስ ብሎ የተፈላ ንጹህ የአረቢካ ቡና።",
  "Ice-chilled naturally refreshing punch made with seasonal Ethiopian fruits including watermelon, passion fruit, and orange.": "ከወቅታዊ የኢትዮጵያ ፍራፍሬዎች የተዘጋጀ ቀዝቃዛ እና አዲስ የፍራፍሬ ጭማቂ።",
  "Pan-fried flatbread shredded and coat in herbal spiced butter (Niter Kibbeh) and berbere, served warm with plain yogurt.": "በቅመም ቅቤ እና በርበሬ የተዘጋጀ ጨጨብሳ፣ በትኩስ ከእርጎ ጋር።",
  "Moist fresh sponge cake with chocolate or vanilla cream frosting, baked fresh daily.": "በየቀኑ ትኩስ የሚጋገር ለስላሳ ስፖንጅ ኬክ ከቸኮሌት ወይም ቫኒላ ክሬም ጋር።",
};

const CATEGORY_AM: Record<string, string> = {
  all: "ሁሉም", soup: "ሾርባ", burger: "በርገር", pasta: "ፓስታ", salad: "ሰላጣ", pizza: "ፒዛ", rice: "ሩዝ",
  "hot-drinks": "ትኩስ መጠጦች", "soft-drinks": "ለስላሳ መጠጦች", juices: "ጭማቂዎች", sandwich: "ሳንድዊች", "snack-and-wrap": "ቀላል ምግቦች", "ethiopian-traditional-meals": "የኢትዮጵያ ምግቦች", "pastry-and-cakes": "ፓስትሪ እና ኬክ",
};

/* ───────────── Google-powered auto-translation for dynamic text ─────────────
 * Anything not covered by the dictionaries above (menu items the owner adds
 * later, new categories, announcements, settings texts…) is translated by the
 * SAME Google engine as the Google Translate widget — but through OUR server
 * (/api/translate). Google never touches the page DOM, so:
 *   • no banner/toolbar ever pops up over the menu
 *   • React never crashes ("removeChild" errors are impossible)
 *   • form values, cart data and order payloads stay canonical English
 *
 * Flow: components call tx(text) → cache hit? show it : show English and
 * register the string → one debounced batched request per view → results are
 * merged (state bump) and every component re-renders with Amharic. Results
 * are persisted in localStorage for instant repeat loads.
 */

const TX_STORAGE_KEY = "fana_tx_am";
const TX_FLUSH_DELAY_MS = 600;
const TX_BATCH_MAX = 120;
const TX_STORAGE_MAX_ENTRIES = 1500;

const GE_EZ_RE = /[\u1200-\u137F]/; // Amharic script already

function txTranslatable(text: string): boolean {
  if (!text || text.length > 1500) return false;
  if (GE_EZ_RE.test(text)) return false;
  return /[a-z]/i.test(text); // needs at least one Latin letter
}

let txCache: Record<string, string> | null = null; // lazy from localStorage
const txRequested = new Set<string>(); // this tab already asked / received
const txQueue = new Set<string>();
const txListeners = new Set<() => void>();
let txVersion = 0;
let txTimer: ReturnType<typeof setTimeout> | null = null;
let txInFlight = false;

function txLoad(): Record<string, string> {
  if (txCache) return txCache;
  txCache = {};
  try {
    const raw = window.localStorage.getItem(TX_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") txCache = parsed as Record<string, string>;
    }
  } catch {}
  return txCache;
}

function txPersist(): void {
  try {
    const entries = Object.entries(txCache ?? {});
    const trimmed = entries.slice(-TX_STORAGE_MAX_ENTRIES); // keep the newest
    window.localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {} // quota/private mode — cache just stays in memory
}

function txEmit(): void {
  txVersion += 1;
  for (const cb of txListeners) cb();
}

function txSubscribe(cb: () => void): () => void {
  txListeners.add(cb);
  return () => txListeners.delete(cb);
}

const txServerSnapshot = 0;
function txGetVersion(): number {
  return txVersion;
}

async function txFlush(): Promise<void> {
  if (txInFlight || txQueue.size === 0) return;
  txInFlight = true;
  const batch = [...txQueue].slice(0, TX_BATCH_MAX);
  for (const s of batch) txQueue.delete(s);
  try {
    const r = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: "am", texts: batch }),
    });
    if (r.ok) {
      const data = await r.json();
      const map = data?.translations;
      let changed = false;
      if (map && typeof map === "object") {
        const cache = txLoad();
        for (const [k, v] of Object.entries(map as Record<string, string>)) {
          if (typeof v === "string" && v) {
            if (cache[k] !== v) changed = true;
            cache[k] = v;
          }
        }
        // every requested string is marked done — even ones Google couldn't
        // translate — so we never re-ask for the same text in this tab.
        for (const s of batch) txRequested.add(s);
        if (changed) {
          txPersist();
          txEmit();
        }
      }
    }
  } catch {
    // offline / server down → keep showing English; retry next registration
  } finally {
    txInFlight = false;
    if (txQueue.size > 0) txSchedule(); // leftovers (batch > TX_BATCH_MAX)
  }
}

function txSchedule(): void {
  if (txTimer) return;
  txTimer = setTimeout(() => {
    txTimer = null;
    void txFlush();
  }, TX_FLUSH_DELAY_MS);
}

function txLookup(text: string): string | undefined {
  if (txCache) return txCache[text];
  return undefined;
}

/** Register a string for auto-translation (only acts when lang = am). */
function txRegister(text: string): void {
  if (!txTranslatable(text)) return;
  txLoad();
  if (txCache?.[text] || txRequested.has(text)) return;
  txRequested.add(text);
  txQueue.add(text);
  txSchedule();
}

/** Best current Amharic for `text` (dictionaries first, then auto-cache). */
function txBest(text: string): string {
  if (!text) return text;
  const lower = text.toLowerCase();
  const manual =
    MENU_AM[text] ?? CATEGORY_AM[lower] ?? CATEGORY_AM[lower.replace(/\s+/g, "-")];
  if (manual) return manual;
  const hit = txLookup(text);
  if (hit) return hit;
  txRegister(text);
  return text;
}

/**
 * Hook: reactive translator for DYNAMIC content (menu items, categories,
 * announcements, settings strings). Returns text unchanged in English mode.
 */
export function useAutoT(): (text: string) => string {
  const [lang] = useLang();
  useSyncExternalStore(txSubscribe, txGetVersion, () => txServerSnapshot);
  return useCallback(
    (text: string) => (lang === "am" ? txBest(text) : text),
    [lang]
  );
}

export function useMenuText() {
  const [lang] = useLang();
  useSyncExternalStore(txSubscribe, txGetVersion, () => txServerSnapshot);
  return useCallback((text: string, category = false) => {
    if (lang !== "am" || !text) return text;
    if (category && CATEGORY_AM[text.toLowerCase()]) return CATEGORY_AM[text.toLowerCase()];
    return txBest(text);
  }, [lang]);
}
