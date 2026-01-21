import mongoose, { Schema, Document } from "mongoose";

export interface IMemory extends Document {
  key: string;
  value: string;
  scope: "global" | "user";
  username: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const MemorySchema = new Schema<IMemory>(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    scope: { type: String, enum: ["global", "user"], required: true },
    username: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true }
);

// Compound index for unique key per scope/user combination
MemorySchema.index({ key: 1, scope: 1, username: 1 }, { unique: true });

export const Memory = mongoose.model<IMemory>("Memory", MemorySchema);
