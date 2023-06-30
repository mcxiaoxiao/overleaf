const { ForbiddenError } = require('../Errors/Errors')
const { hasPermission } = require('./PermissionsManager')
const ManagedUsersHandler = require('../Subscription/ManagedUsersHandler')

/**
 * Function that returns middleware to check if the user has permission to access a resource.
 * @param {[string]} requiredCapabilities - the capabilities required to access the resource.
 * @returns {Function} The middleware function that checks if the user has the required capabilities.
 */
function requirePermission(...requiredCapabilities) {
  if (
    requiredCapabilities.length === 0 ||
    requiredCapabilities.some(capability => typeof capability !== 'string')
  ) {
    throw new Error('invalid required capabilities')
  }
  const doRequest = async function (req, res, next) {
    if (!req.user) {
      return next(new Error('no user'))
    }
    try {
      // get the group policy applying to the user
      const groupPolicy =
        await ManagedUsersHandler.promises.getGroupPolicyForUser(req.user)
      // if there is no group policy, the user is not managed
      if (!groupPolicy) {
        return next()
      }
      // check that the user has all the required capabilities
      for (const requiredCapability of requiredCapabilities) {
        // if the user has the permission, continue
        if (!hasPermission(groupPolicy, requiredCapability)) {
          throw new ForbiddenError(
            `user does not have permission for ${requiredCapability}`
          )
        }
      }
      next()
    } catch (error) {
      next(error)
    }
  }
  return doRequest
}

module.exports = {
  requirePermission,
}