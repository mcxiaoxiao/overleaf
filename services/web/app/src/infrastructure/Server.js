const Path = require('path')
const express = require('express')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const metrics = require('@overleaf/metrics')
const Validation = require('./Validation')
const csp = require('./CSP')
const Router = require('../router')
const helmet = require('helmet')
const UserSessionsRedis = require('../Features/User/UserSessionsRedis')
const Csrf = require('./Csrf')
const HttpPermissionsPolicyMiddleware = require('./HttpPermissionsPolicy')

const sessionsRedisClient = UserSessionsRedis.client()

const SessionAutostartMiddleware = require('./SessionAutostartMiddleware')
const AnalyticsManager = require('../Features/Analytics/AnalyticsManager')
const session = require('express-session')
const CookieMetrics = require('./CookieMetrics')
const CustomSessionStore = require('./CustomSessionStore')
const bodyParser = require('./BodyParserWrapper')
const methodOverride = require('method-override')
const cookieParser = require('cookie-parser')
const bearerTokenMiddleware = require('express-bearer-token')

const passport = require('passport')
const LocalStrategy = require('passport-local').Strategy

const oneDayInMilliseconds = 86400000
const ReferalConnect = require('../Features/Referal/ReferalConnect')
const RedirectManager = require('./RedirectManager')
const translations = require('./Translations')
const Views = require('./Views')
const Features = require('./Features')

const ErrorController = require('../Features/Errors/ErrorController')
const HttpErrorHandler = require('../Features/Errors/HttpErrorHandler')
const UserSessionsManager = require('../Features/User/UserSessionsManager')
const AuthenticationController = require('../Features/Authentication/AuthenticationController')
const SessionManager = require('../Features/Authentication/SessionManager')
const {
  hasAdminAccess,
} = require('../Features/Helpers/AdminAuthorizationHelper')

const Modules = require('./Modules')
const expressLocals = require('./ExpressLocals')

const STATIC_CACHE_AGE = Settings.cacheStaticAssets
  ? oneDayInMilliseconds * 365
  : 0

// Init the session store
const sessionStore = new CustomSessionStore({ client: sessionsRedisClient })

const app = express()

const webRouter = express.Router()
const privateApiRouter = express.Router()
const publicApiRouter = express.Router()

if (Settings.behindProxy) {
  app.set('trust proxy', Settings.trustedProxyIps || true)
  /**
   * Handle the X-Original-Forwarded-For header.
   *
   * The nginx ingress sends us the contents of X-Forwarded-For it received in
   * X-Original-Forwarded-For. Express expects all proxy IPs to be in a comma
   * separated list in X-Forwarded-For.
   */
  app.use(function getForwardedForHeader(req, res, next) {
    if (
      req.headers['x-original-forwarded-for'] &&
      req.headers['x-forwarded-for']
    ) {
      req.headers['x-forwarded-for'] =
        req.headers['x-original-forwarded-for'] +
        ', ' +
        req.headers['x-forwarded-for']
    }
    next()
  })
}

// `req.ip` is a getter on the underlying socket.
// The socket details are freed as the connection is dropped -- aka aborted.
// Hence `req.ip` may read `undefined` upon connection drop.
// A couple of places require a valid IP at all times. Cache it!
const ORIGINAL_REQ_IP = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(app.request),
  'ip'
).get
Object.defineProperty(app.request, 'ip', {
  configurable: true,
  enumerable: true,
  get: function ipWithCache() {
    const ip = ORIGINAL_REQ_IP.call(this)
    // Shadow the prototype level getter with a property on the instance.
    // Any future access on `req.ip` will get served by the instance property.
    Object.defineProperty(this, 'ip', { value: ip })
    return ip
  },
})
app.use(function ignoreAbortedConnections(req, res, next) {
  if (req.destroyed) {
    // Request has been aborted already.
    return
  }
  // Implicitly cache the ip, see above.
  if (!req.ip) {
    // Critical connection details are missing.
    return
  }
  next()
})

if (Settings.exposeHostname) {
  const HOSTNAME = require('os').hostname()
  app.use(function exposeHostname(req, res, next) {
    res.setHeader('X-Served-By', HOSTNAME)
    next()
  })
}

webRouter.use(
  express.static(Path.join(__dirname, '/../../../public'), {
    maxAge: STATIC_CACHE_AGE,
    setHeaders: csp.removeCSPHeaders,
  })
)
app.set('views', Path.join(__dirname, '/../../views'))
app.set('view engine', 'pug')

if (Settings.enabledServices.includes('web')) {
  if (app.get('env') !== 'development') {
    logger.debug('enabling view cache for production or acceptance tests')
    app.enable('view cache')
  }
  if (Settings.precompilePugTemplatesAtBootTime) {
    logger.debug('precompiling views for web in production environment')
    Views.precompileViews(app)
  }
  Modules.loadViewIncludes(app)
}

app.use(metrics.http.monitor(logger))

Modules.applyMiddleware(app, 'appMiddleware')
app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }))
app.use(bodyParser.json({ limit: Settings.max_json_request_size }))
app.use(methodOverride())
// add explicit name for telemetry
app.use(bearerTokenMiddleware())

if (Settings.blockCrossOriginRequests) {
  app.use(Csrf.blockCrossOriginRequests())
}

if (Settings.useHttpPermissionsPolicy) {
  const httpPermissionsPolicy = new HttpPermissionsPolicyMiddleware(
    Settings.httpPermissions
  )
  logger.debug('adding permissions policy config', Settings.httpPermissions)

  webRouter.use(httpPermissionsPolicy.middleware)
}

RedirectManager.apply(webRouter)

if (!Settings.security.sessionSecret) {
  throw new Error('No SESSION_SECRET provided.')
}

const sessionSecrets = [
  Settings.security.sessionSecret,
  Settings.security.sessionSecretUpcoming,
  Settings.security.sessionSecretFallback,
].filter(Boolean)

webRouter.use(cookieParser(sessionSecrets))
webRouter.use(CookieMetrics.middleware)
SessionAutostartMiddleware.applyInitialMiddleware(webRouter)
Modules.applyMiddleware(webRouter, 'sessionMiddleware', {
  store: sessionStore,
})
webRouter.use(
  session({
    resave: false,
    saveUninitialized: false,
    secret: sessionSecrets,
    proxy: Settings.behindProxy,
    cookie: {
      domain: Settings.cookieDomain,
      maxAge: Settings.cookieSessionLength, // in milliseconds, see https://github.com/expressjs/session#cookiemaxage
      secure: Settings.secureCookie,
      sameSite: Settings.sameSiteCookie,
    },
    store: sessionStore,
    key: Settings.cookieName,
    rolling: Settings.cookieRollingSession === true,
  })
)
if (Features.hasFeature('saas')) {
  webRouter.use(AnalyticsManager.analyticsIdMiddleware)
}

// passport
webRouter.use(passport.initialize())
webRouter.use(passport.session())

passport.use(
  new LocalStrategy(
    {
      passReqToCallback: true,
      usernameField: 'email',
      passwordField: 'password',
    },
    AuthenticationController.doPassportLogin
  )
)
passport.serializeUser(AuthenticationController.serializeUser)
passport.deserializeUser(AuthenticationController.deserializeUser)

Modules.hooks.fire('passportSetup', passport, function (err) {
  if (err != null) {
    logger.err({ err }, 'error setting up passport in modules')
  }
})

Modules.applyNonCsrfRouter(webRouter, privateApiRouter, publicApiRouter)

webRouter.csrf = new Csrf()
webRouter.use(webRouter.csrf.middleware)
webRouter.use(translations.i18nMiddleware)
webRouter.use(translations.setLangBasedOnDomainMiddleware)

if (Settings.cookieRollingSession) {
  // Measure expiry from last request, not last login
  webRouter.use(function touchSession(req, res, next) {
    if (!req.session.noSessionCallback) {
      req.session.touch()
      if (SessionManager.isUserLoggedIn(req.session)) {
        UserSessionsManager.touch(
          SessionManager.getSessionUser(req.session),
          err => {
            if (err) {
              logger.err({ err }, 'error extending user session')
            }
          }
        )
      }
    }
    next()
  })
}

webRouter.use(ReferalConnect.use)
expressLocals(webRouter, privateApiRouter, publicApiRouter)

webRouter.use(SessionAutostartMiddleware.invokeCallbackMiddleware)

webRouter.use(function checkIfSiteClosed(req, res, next) {
  if (Settings.siteIsOpen) {
    next()
  } else if (hasAdminAccess(SessionManager.getSessionUser(req.session))) {
    next()
  } else {
    HttpErrorHandler.maintenance(req, res)
  }
})

webRouter.use(function checkIfEditorClosed(req, res, next) {
  if (Settings.editorIsOpen) {
    next()
  } else if (req.url.indexOf('/admin') === 0) {
    next()
  } else {
    HttpErrorHandler.maintenance(req, res)
  }
})

webRouter.use(AuthenticationController.validateAdmin)

// add security headers using Helmet
const noCacheMiddleware = require('nocache')()
webRouter.use(function addNoCacheHeader(req, res, next) {
  const isProjectPage = /^\/project\/[a-f0-9]{24}$/.test(req.path)
  if (isProjectPage) {
    // always set no-cache headers on a project page, as it could be an anonymous token viewer
    return noCacheMiddleware(req, res, next)
  }

  const isProjectFile = /^\/project\/[a-f0-9]{24}\/file\/[a-f0-9]{24}$/.test(
    req.path
  )
  if (isProjectFile) {
    // don't set no-cache headers on a project file, as it's immutable and can be cached (privately)
    return next()
  }

  const isWikiContent = /^\/learn(-scripts)?(\/|$)/i.test(req.path)
  if (isWikiContent) {
    // don't set no-cache headers on wiki content, as it's immutable and can be cached (publicly)
    return next()
  }

  const isLoggedIn = SessionManager.isUserLoggedIn(req.session)
  if (isLoggedIn) {
    // always set no-cache headers for authenticated users (apart from project files, above)
    return noCacheMiddleware(req, res, next)
  }

  // allow other responses (anonymous users, except for project pages) to be cached
  return next()
})
webRouter.use(
  helmet({
    // note that more headers are added by default
    dnsPrefetchControl: false,
    referrerPolicy: { policy: 'origin-when-cross-origin' },
    hsts: false,
    // Disabled because it's impractical to include every resource via CORS or
    // with the magic CORP header
    crossOriginEmbedderPolicy: false,
    // We need to be able to share the context of some popups. For example,
    // when Recurly opens Paypal in a popup.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // Disabled because it's not a security header and has possibly-unwanted
    // effects
    originAgentCluster: false,
    // We have custom handling for CSP below, so Helmet's default is disabled
    contentSecurityPolicy: false,
  })
)

// add CSP header to HTML-rendering routes, if enabled
if (Settings.csp && Settings.csp.enabled) {
  logger.debug('adding CSP header to rendered routes', Settings.csp)
  app.use(csp(Settings.csp))
}

logger.debug('creating HTTP server'.yellow)
const server = require('http').createServer(app)

// provide settings for separate web and api processes
if (Settings.enabledServices.includes('api')) {
  logger.debug('providing api router')
  app.use(privateApiRouter)
  app.use(Validation.errorMiddleware)
  app.use(ErrorController.handleApiError)
}

if (Settings.enabledServices.includes('web')) {
  logger.debug('providing web router')
  app.use(publicApiRouter) // public API goes with web router for public access
  app.use(Validation.errorMiddleware)
  app.use(ErrorController.handleApiError)

  app.use(webRouter)
  app.use(Validation.errorMiddleware)
  app.use(ErrorController.handleError)
}

metrics.injectMetricsRoute(webRouter)
metrics.injectMetricsRoute(privateApiRouter)

Router.initialize(webRouter, privateApiRouter, publicApiRouter)

module.exports = {
  app,
  server,
}
