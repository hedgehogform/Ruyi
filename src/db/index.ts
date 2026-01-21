import mongoose from "mongoose";

const MONGO_URI = Bun.env.MONGO_URI || "mongodb://localhost:27017/ruyi";

export async function connectDB(): Promise<typeof mongoose> {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    // Force exit on connection errors after initial connect
    mongoose.connection.on("error", (error) => {
      console.error("MongoDB connection error:", error);
      process.exit(1);
    });

    mongoose.connection.on("disconnected", () => {
      console.error("MongoDB disconnected unexpectedly");
      process.exit(1);
    });

    return mongoose;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}

export async function closeDB(): Promise<void> {
  await mongoose.disconnect();
}
