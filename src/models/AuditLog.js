import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    actorRole: String,
    action: { type: String, required: true, index: true }, // e.g. "department.create"
    entity: { type: String, required: true }, // e.g. "Department"
    entityId: { type: mongoose.Schema.Types.ObjectId },
    meta: { type: mongoose.Schema.Types.Mixed },
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export default mongoose.model('AuditLog', auditLogSchema);
