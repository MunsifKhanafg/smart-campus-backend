import AuditLog from '../models/AuditLog.js';

// Fire-and-forget: an audit failure must never break the real request.
export const logAudit = (req, action, entity, entityId, meta = {}) => {
  AuditLog.create({
    actor: req.user?._id,
    actorRole: req.user?.role,
    action,
    entity,
    entityId,
    meta,
    ip: req.ip,
  }).catch((err) => console.error('Audit log failed:', err.message));
};
