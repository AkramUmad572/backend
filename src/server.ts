import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// Log only actual API requests (filter out health checks, etc.)
app.use((req, res, next) => {
  // Skip logging for common noise
  if (!req.path.includes('favicon') && 
      !req.path.includes('health') && 
      !req.path.includes('robots.txt')) {

      const realIP = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
      console.log(`📡 ${req.method} ${req.path} from ${realIP} (${req.headers['user-agent']?.slice(0, 50)})`);
  }
  next();
});

app.get('/', (req, res) => {
  res.json({ message: 'Hello World!' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});