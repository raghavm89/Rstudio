/**
 * zoqstudio.ai — pre-launch page content. THE ONE FILE TO EDIT.
 *
 * Everything a non-developer would want to change before launch lives here:
 * the social handles, the Instagram / YouTube posts shown in "From the feed",
 * and the catalogue faces with their status. The page (`components/Prelaunch.jsx`)
 * reads this and nothing else, so pasting a post link is a one-line change +
 * a push; Vercel redeploys.
 *
 * Positioning rule (CLAUDE.md): never "AI video" / "AI avatar" — ZoQ is
 * "your own AI influencer", "a persona that posts".
 */

export const SITE = {
  domain: 'zoqstudio.ai',
  url: 'https://zoqstudio.ai',
  launch: 'November 2026',
  launchShort: 'NOV 2026',
  email: 'hello@zoqstudio.ai',
  // Leave a handle empty ('') to hide its button.
  instagram: '',   // e.g. 'https://www.instagram.com/aanya.kapoor.ai/'
  youtube: '',     // e.g. 'https://www.youtube.com/@aanyakapoor'
  // Show the indicative plan ladder? Numbers are the frozen v1 spec
  // (docs/TECH-OVERVIEW.md §4). Flip to false while P1–P8 are being decided.
  showPlans: true,
};

/**
 * Paste Instagram post / reel links and YouTube video / Shorts links here, newest
 * first. Any of these shapes work:
 *   https://www.instagram.com/p/XXXX/     https://www.instagram.com/reel/XXXX/
 *   https://www.youtube.com/watch?v=ID    https://youtu.be/ID    https://youtube.com/shorts/ID
 * Anything unrecognised is skipped (and reported in the build log), never shown broken.
 */
export const POSTS = [
  // 'https://www.instagram.com/reel/…/',
  // 'https://youtu.be/…',
];

/**
 * The catalogue as it will read at launch. `status` is one of:
 *   'live'     — trained, calibrated, real renders (has media)
 *   'training' — bible written, seed set / LoRA in progress
 *   'soon'     — planned, bible drafted
 * `media` is a still under /public; `video` an optional loop. Faces without media
 * render a monogram plate, so the grid is complete at every point.
 */
export const CATALOGUE = [
  {
    slug: 'aanya-kapoor', name: 'Aanya Kapoor', place: 'Mumbai',
    line: 'Designer by day, runner by 6am. The first face — and the one already posting.',
    status: 'live', kind: 'persona',
    media: '/hero/setup-close.jpg', video: '/hero/hero.mp4',
  },
  {
    slug: 'rohan-mehra', name: 'Rohan Mehra', place: 'Mumbai',
    line: 'Runs a ten-seat café off a Bandra lane. Good at the coffee, bad at the marketing.',
    status: 'live', kind: 'persona',
    media: '/hero/rohan-mehra/close.jpg', video: '/hero/rohan-mehra/hero.mp4',
  },
  {
    slug: 'zoq-mascot', name: 'ZoQ', place: 'Brand mascot',
    line: 'One locked character, every context — the proof that a brand mascot can post daily.',
    status: 'live', kind: 'character',
    media: '/hero/mascot/hero.jpg', video: '/hero/mascot/hero.mp4',
  },
  {
    slug: 'meera-gill', name: 'Meera Gill', place: 'Delhi',
    line: 'Punjabi-suit boutique in Lajpat Nagar. Wedding season is her content calendar.',
    status: 'training', kind: 'persona',
  },
  {
    slug: 'meera-iyer', name: 'Meera Iyer', place: 'Mumbai',
    line: 'Research job, Bharatanatyam on weekends, runs the group chat.',
    status: 'training', kind: 'persona',
  },
  {
    slug: 'meher-anand', name: 'Meher Anand', place: 'Delhi',
    line: 'South-Delhi cosmopolitan — cafés, concept stores, a design desk in Hauz Khas.',
    status: 'soon', kind: 'persona',
  },
  {
    slug: 'kabir-sethi', name: 'Kabir Sethi', place: 'Delhi',
    line: 'Smart-streetwear, agency coffee culture, dry Hinglish.',
    status: 'soon', kind: 'persona',
  },
  {
    slug: 'simran-gill', name: 'Simran Gill', place: 'Punjab',
    line: 'Chandigarh bright — Sukhna at sunrise, mustard fields at golden hour.',
    status: 'soon', kind: 'persona',
  },
  {
    slug: 'arjan-brar', name: 'Arjan Singh Brar', place: 'Punjab',
    line: 'Farm-edge mornings, akhara evenings. Few words, all of them solid.',
    status: 'soon', kind: 'persona',
  },
];

/**
 * The offering, one card each. `when` is 'launch' (ships Nov 2026) or 'later'
 * (after launch — never sold before it runs end to end).
 */
export const OFFERINGS = [
  {
    key: 'persona', title: 'AI persona', when: 'launch',
    tag: 'Free → Pro',
    text: 'Pick a catalogue face or build your own. One brief becomes a week of stills, reels and Hinglish captions — the same face in every shot, checked against a calibrated likeness before you see a frame.',
  },
  {
    key: 'mascot', title: 'AI brand mascot', when: 'launch',
    tag: 'Pro',
    text: 'A character your brand owns outright — no likeness, no consent problem, never misses a posting day. Personified products, shop mascots, a squirrel if you like.',
  },
  {
    key: 'stories', title: 'Ready-to-go story reels', when: 'launch',
    tag: 'Free',
    text: 'Pick a story, get a two-character reel with the cast and dialogue already written — each character heard in their own voice, lip-synced. Zero setup. The library fills in as the catalogue grows.',
  },
  {
    key: 'clone', title: 'AI clone of you', when: 'launch',
    tag: 'Pro · verified consent',
    text: 'Your own likeness from a consented video: a twin that posts as you, in your cloned Hindi/Hinglish voice. We can only clone you — never anyone else.',
  },
  {
    key: 'voice', title: 'Indian-language voice', when: 'launch',
    tag: 'Hindi first',
    text: 'Owned, India-hosted voice: Hindi and Hinglish at launch, more Indic languages after. One reel, many languages.',
  },
  {
    key: 'live', title: 'Live AI clone that talks back', when: 'later',
    tag: 'Ultra · after launch',
    text: 'A real-time version of your clone for web, WhatsApp and Instagram DMs. Stays off the price list until it runs end to end.',
  },
];

/** Indicative plan ladder — frozen v1 numbers. Ultra is shown without the live clone. */
export const PLANS = [
  { amt: 'Free',    plan: 'STARTER',   desc: '1 catalogue face · a first shoot, no card' },
  { amt: '₹999',    plan: 'CATALOGUE', desc: '1 catalogue face · posts every week' },
  { amt: '₹2,000',  plan: 'PRO',       desc: 'Your own persona, mascot or clone', hot: true },
  { amt: '₹7,000',  plan: 'MAX',       desc: '5 avatars · 720p reels · brands' },
  { amt: '₹15,000', plan: 'ULTRA',     desc: '12 avatars · team seats · agencies' },
];
