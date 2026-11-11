import mongoose from 'mongoose';

// The profile photo of a person (any role, students too).
// It is kept in the DATABASE, not in a folder: the file is small (the page shrinks it to about 320 x 320 pixels first), and a folder would
// lose the photos whenever the server restarts on a host such as Vercel. It lives in its own collection so the user lists stay light:
// the User only carries two small fields (hasPhoto, photoUpdatedAt), and the picture is fetched one by one when a screen shows it.
const userPhotoSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
    data: { type: Buffer, required: true },
    size: { type: Number, required: true },
  },
  { timestamps: true }
);

export default mongoose.model('UserPhoto', userPhotoSchema);
