'use strict';

const { Router }   = require('express');
const authenticate = require('../middleware/auth');
const authorize    = require('../middleware/role');
const asyncHandler = require('../middleware/asyncHandler');
const parseId      = require('../middleware/parseId');
const workerAuth   = require('../middleware/workerAuth');
const requireAudience = require('../middleware/requireAudience');
const ctrl         = require('../controllers/studioJobController');
const shootCtrl    = require('../controllers/studioShootController');
const avatarCtrl   = require('../controllers/studioAvatarController');
const fileCtrl     = require('../controllers/studioFileController');

const router = Router();

/**
 * Mount in app.js as:
 *   const studioRoutes = require('./routes/studio');
 *   app.use('/api/studio', studioRoutes);
 *
 * Worker routes are declared FIRST and carry their own auth. They must not sit
 * behind `authenticate`, because a render worker has no user session — and they
 * must not be reachable with a user token either, which is why each one states
 * `workerAuth` explicitly rather than inheriting anything.
 */

// ── Worker plane ──────────────────────────────────────────────────────────────
// Shared secret in STUDIO_WORKER_TOKEN + X-Worker-Id. Can claim and report
// work; cannot read tenant content, billing or users.
router.get ('/jobs/next',              workerAuth, asyncHandler(ctrl.claimNext));
router.post('/jobs/:id/heartbeat',     workerAuth, parseId('id'), asyncHandler(ctrl.heartbeat));
router.post('/jobs/:id/result',        workerAuth, parseId('id'), asyncHandler(ctrl.report));
router.post('/jobs/:id/upload-target', workerAuth, parseId('id'), asyncHandler(ctrl.uploadTarget));
router.post('/jobs/reap',              workerAuth, asyncHandler(ctrl.reap));

// ── File plane (local storage driver only) ────────────────────────────────────
// Deliberately outside `authenticate`. `upload` is authorised by the HMAC in its
// own query string — the same model as an S3 presigned PUT — and `serve` is
// public because Instagram FETCHES media from a URL rather than accepting an
// upload. Both 404 when STUDIO_STORAGE is not `local`.
router.put('/files/upload', asyncHandler(fileCtrl.upload));
router.get ('/files/*',     asyncHandler(fileCtrl.serve));

// A candidate frame, authorised by the HMAC in its own query string for the
// same reason `upload` is: an `<img>` tag sends no Authorization header, and
// pulling three hundred thumbnails through fetch into blob URLs would defeat
// lazy loading and hold the whole pool in memory.
//
// Unlike `/files/*` this is NOT public. Published media has to be readable by
// Instagram; a training-set candidate does not, and for a `twin` it is a
// photograph of a real person. The signature covers tenant, avatar and filename
// together, and every failure answers the same 404 so an unauthenticated caller
// cannot learn which ids exist.
const candidateCtrl = require('../controllers/studioCandidateController');
//
// `/candidates/img/:filename` rather than `/candidates/:filename`: this route is
// registered here, before `authenticate`, so it matches BEFORE anything on the
// people plane. With the shorter path it swallowed
// `GET /avatars/:id/candidates/quote` — four segments each — and answered a
// signed-image 404 to an authenticated caller asking what a batch would cost.
// The unauthenticated route is the unusual one, so it takes the longer path.
router.get('/avatars/:id/candidates/img/:filename', parseId('id'), asyncHandler(candidateCtrl.image));

// ── People plane ──────────────────────────────────────────────────────────────
router.use(authenticate);

// A token minted for the rstudio.app dashboard must not work here. `admin` is
// allowed alongside `studio` so internal support can operate a tenant's Studio
// without a second login; drop it if that is not wanted.
router.use(requireAudience('studio', 'admin'));

const TENANT_ROLES = ['tenant_admin', 'tenant_user', 'admin', 'developer'];

// Bootstrap. Deliberately NOT behind `authorize(...TENANT_ROLES)`: this is the
// call that gives a brand-new account its workspace, and a signed-in person with
// no workspace yet is exactly who needs it. Gating it on the roles that imply
// membership would lock out the only people it exists for.
router.get('/me', asyncHandler(require('../controllers/studioMeController').me));

// Account and billing details. Separate from /me, which runs on every cold start
// and provisions a workspace as a side effect — a GSTIN has no business
// travelling on that request.
const profile = require('../controllers/studioProfileController');
router.get('/profile', asyncHandler(profile.getProfile));

// Plans and the tenant's credit position. Read by the billing page.
router.get('/plans', asyncHandler(require('../controllers/studioPlansController').plans));

// Buying, and the paperwork that follows it.
const billing = require('../controllers/studioBillingController');
router.post('/billing/subscribe', asyncHandler(billing.subscribe));
router.post('/billing/topup',     asyncHandler(billing.topup));
router.post('/billing/verify',    asyncHandler(billing.verify));
router.get ('/billing/credits',   asyncHandler(billing.creditBalance));
router.get ('/invoices',          asyncHandler(billing.listInvoices));
router.get ('/invoices/:id',      asyncHandler(billing.getInvoice));
router.put('/profile', asyncHandler(profile.updateProfile));

// ── Back office ───────────────────────────────────────────────────────────────
// The only cross-tenant reads in the product, and therefore the only place a
// missing WHERE is a breach rather than a bug. `authorize('admin')` on the
// whole sub-router is the entire security boundary: it is applied once, to a
// mounted router, rather than repeated per route — a per-route list is a list
// somebody eventually adds a route without.
//
// `admin` here is the platform role from users.role, which registration refuses
// to grant (authController) and only scripts/create-admin.js can set.
const adminRouter = Router();
adminRouter.use(authorize('admin'));

const admin = require('../controllers/studioAdminController');
adminRouter.get ('/overview',            asyncHandler(admin.overview));
adminRouter.get ('/tenants',             asyncHandler(admin.listTenants));
adminRouter.get ('/tenants/:id',         parseId('id'), asyncHandler(admin.getTenant));
adminRouter.post('/tenants/:id/credits', parseId('id'), asyncHandler(admin.grantCredits));
adminRouter.get ('/money',               asyncHandler(admin.money));
adminRouter.get ('/jobs',                asyncHandler(admin.jobs));
adminRouter.post('/jobs/:id/requeue',    parseId('id'), asyncHandler(admin.requeueJob));
adminRouter.post('/query',               asyncHandler(admin.query));
adminRouter.get ('/audit',               asyncHandler(admin.auditLog));
adminRouter.get   ('/consents',          asyncHandler(admin.listConsents));
adminRouter.post  ('/consents/:id/approve', parseId('id'), asyncHandler(admin.approveConsent));
adminRouter.get   ('/character-attestations',            asyncHandler(admin.listCharacterAttestations));
adminRouter.post  ('/character-attestations/:id/takedown', parseId('id'), asyncHandler(admin.takedownCharacter));
adminRouter.get   ('/catalogue',         asyncHandler(admin.listCatalogue));
adminRouter.post  ('/catalogue',         asyncHandler(admin.addCatalogue));
adminRouter.delete('/catalogue/:id',     parseId('id'), asyncHandler(admin.removeCatalogue));

router.use('/admin', adminRouter);

// The one click. Everything else on this plane is plumbing around it.
router.get ('/shoots',                 authorize(...TENANT_ROLES), asyncHandler(shootCtrl.list));
router.post('/shoots',                 authorize(...TENANT_ROLES), asyncHandler(shootCtrl.create));
router.post('/shoots/plan',            authorize(...TENANT_ROLES), asyncHandler(shootCtrl.plan));
router.post('/shoots/generate',        authorize(...TENANT_ROLES), asyncHandler(shootCtrl.generate));
router.post('/transcribe',             authorize(...TENANT_ROLES), asyncHandler(shootCtrl.transcribe));
router.get ('/shoots/:id',             authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.progress));
router.get ('/shoots/:id/plan',        authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.shootPlan));
router.post('/shoots/:id/approve',      authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.approve));
router.post('/shoots/:id/select-still', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.selectStill));
router.post('/shoots/:id/reanimate',    authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.reanimate));
router.post('/shoots/:id/regenerate-stills', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.regenerateStills));
router.post('/shoots/:id/replan',      authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.replan));
router.post('/shoots/:id/discard',     authorize(...TENANT_ROLES), parseId('id'), asyncHandler(shootCtrl.discard));
router.get ('/limits',                 authorize(...TENANT_ROLES), asyncHandler(shootCtrl.limits));

// The persona list, and making one.
//
// `list` replaces a fetch the avatars page was making to the culling service on
// :5055 — no authentication, no tenant scoping, and it answered with every
// avatar in the database.
router.get ('/avatars',       authorize(...TENANT_ROLES), asyncHandler(avatarCtrl.list));
// The identity-block rules, so the form can check as you type without keeping
// its own copy of the word lists. `create` re-checks and is the authority.
router.get ('/avatars/rules', authorize(...TENANT_ROLES), asyncHandler(avatarCtrl.identityRules));

// ── Shared catalogue (frozen offering §1) — browse, adopt, and (admin) publish.
const catalogueCtrl = require('../controllers/studioCatalogueController');
router.get ('/catalogue',            authorize(...TENANT_ROLES), asyncHandler(catalogueCtrl.browse));
router.get ('/catalogue/selected',   authorize(...TENANT_ROLES), asyncHandler(catalogueCtrl.selected));
router.post('/catalogue/:id/select', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(catalogueCtrl.select));
// Publishing a built avatar into the shared library is a platform action.
router.post('/avatars/:id/publish-to-catalogue', authorize('admin'), parseId('id'), asyncHandler(catalogueCtrl.publish));

// ── Content templates — reusable ad / viral recipes applied onto an avatar.
// Platform library + a tenant's own; apply = a shoot via the orchestrator.
const templateCtrl = require('../controllers/studioTemplateController');
router.get   ('/templates',                authorize(...TENANT_ROLES), asyncHandler(templateCtrl.list));
router.post  ('/templates',                authorize(...TENANT_ROLES), asyncHandler(templateCtrl.create));
router.post  ('/templates/extract',        authorize(...TENANT_ROLES), asyncHandler(templateCtrl.extract));
router.post  ('/templates/from-shoot/:id', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(templateCtrl.saveFromShoot));
router.get   ('/templates/:id',            authorize(...TENANT_ROLES), parseId('id'), asyncHandler(templateCtrl.get));
router.post  ('/templates/:id/apply',      authorize(...TENANT_ROLES), parseId('id'), asyncHandler(templateCtrl.apply));
router.delete('/templates/:id',            authorize(...TENANT_ROLES), parseId('id'), asyncHandler(templateCtrl.remove));
router.post  ('/templates/:id/publish',    authorize('admin'), parseId('id'), asyncHandler(templateCtrl.publish));
// Story library — ready-to-go multi-character stories (cast baked in).
router.get   ('/stories',                  authorize(...TENANT_ROLES), asyncHandler(templateCtrl.stories));
router.post  ('/templates/:id/apply-story',authorize(...TENANT_ROLES), parseId('id'), asyncHandler(templateCtrl.applyStory));
router.post('/avatars',       authorize(...TENANT_ROLES), asyncHandler(avatarCtrl.create));
// After /avatars/rules, so the literal segment is matched before the parameter.
router.get ('/avatars/:id',   authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.get));

// Clone consent — create a record for a twin, and verify it is the same person.
const consentCtrl = require('../controllers/studioConsentController');
router.post('/avatars/:id/upload-target', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.uploadTarget));
router.post('/avatars/:id/twin-material', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.twinMaterial));
router.get ('/avatars/:id/twin-status',   authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.twinStatus));
router.post('/avatars/:id/voice',          authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.setVoice));
router.post('/avatars/:id/voice/clone',    authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.voiceClone));
router.delete('/avatars/:id', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.remove));
router.post('/avatars/:id/consent', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(consentCtrl.create));
router.post('/consent/:id/verify',  authorize(...TENANT_ROLES), parseId('id'), asyncHandler(consentCtrl.verify));

// Mode 3 — character image upload. The attestation is logged before the bytes:
// `attest` records the rights tick + returns a presigned target; the operator
// ingest turns the uploaded image into an anchor + pool.
router.post('/avatars/:id/character-upload/attest',  authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.attestCharacterUpload));
router.get ('/avatars/:id/character-upload/status',  authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.characterUploadStatus));

// Culling — the pool, the verdicts and the export gate.
//
// This replaces a standalone HTTP service on :5055 that had no authentication
// and no tenant scoping: it answered `/api/candidates?avatar=N` for any N to
// anyone who could reach the port, and kept the verdicts in a JSON file beside
// the pictures. The decisions now live in `seed_candidates`, scoped like
// everything else on this plane.
router.get ('/candidates/rules',              authorize(...TENANT_ROLES), asyncHandler(candidateCtrl.rules));
// Not scoped to an avatar: the New avatar form needs a price before the avatar
// exists, and the cost never depended on which avatar the frames are for.
router.get ('/candidates/quote',              authorize(...TENANT_ROLES), asyncHandler(candidateCtrl.tenantQuote));
router.get ('/avatars/:id/candidates',        authorize(...TENANT_ROLES), parseId('id'), asyncHandler(candidateCtrl.list));
router.post('/avatars/:id/candidates',        authorize(...TENANT_ROLES), parseId('id'), asyncHandler(candidateCtrl.mark));
router.get ('/avatars/:id/candidates/quote',   authorize(...TENANT_ROLES), parseId('id'), asyncHandler(candidateCtrl.quote));
router.post('/avatars/:id/candidates/generate', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(candidateCtrl.generate));

// Choosing the face, before a pool is generated from it. `/anchors` reads the
// handful of independent draws; `/anchor` takes one. Registered after
// `/candidates/...` so neither can shadow the other — the collision that put
// `/candidates/quote` behind an unauthenticated image route.
router.get ('/avatars/:id/anchors', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(candidateCtrl.anchors));
router.post('/avatars/:id/anchor',  authorize(...TENANT_ROLES), parseId('id'), asyncHandler(candidateCtrl.chooseAnchor));
router.post('/avatars/:id/seed-set/export',   authorize(...TENANT_ROLES), parseId('id'), asyncHandler(candidateCtrl.exportSet));

// Avatar setup: seed set → train → calibrate → activate. The services enforce
// the order; walking these politely is not what makes it safe.
router.post('/avatars/:id/seed-set',   authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.seedSetTarget));
router.get ('/avatars/:id/look',       authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.look));
router.put ('/avatars/:id/look',       authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.updateLook));
// Training, in the order a person does it: measure the set, look at what it
// found and what it costs, then spend. `/train/check` is registered BEFORE
// `/train` — both are four segments, and Express takes the first that matches.
router.post('/avatars/:id/train/check', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.trainCheck));
router.get ('/avatars/:id/train',       authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.trainStatus));
router.post('/avatars/:id/train',       authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.train));
router.get ('/loras/:id/calibration',  authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.calibrationPlan));
// Generate the frames, then record what they measured. Listed in that order
// because that is the order a person does them; neither path can shadow the
// other, since Express matches the whole path and these differ in length.
router.post('/loras/:id/calibration/run', authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.calibrationRun));
router.post('/loras/:id/calibration',  authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.recordCell));
router.get ('/loras/:id/readiness',    authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.readiness));
router.post('/loras/:id/activate',     authorize(...TENANT_ROLES), parseId('id'), asyncHandler(avatarCtrl.activate));

router.post('/jobs',                   authorize(...TENANT_ROLES), asyncHandler(ctrl.enqueue));
router.get ('/jobs/:id',               authorize(...TENANT_ROLES), parseId('id'), asyncHandler(ctrl.get));
router.get ('/projects/:id/jobs',      authorize(...TENANT_ROLES), parseId('id'), asyncHandler(ctrl.listForProject));
router.get ('/usage',                  authorize(...TENANT_ROLES), asyncHandler(ctrl.usage));

module.exports = router;
