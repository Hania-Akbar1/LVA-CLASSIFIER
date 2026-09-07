const express = require('express');
const path = require('path');
const config = require('./config');
const uploadRoutes = require('./routes/upload');
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/upload', uploadRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', storageProvider: config.storageProvider });
});

// CHANGED: log and exit instead of staying alive after an uncaught exception.
// Once an uncaught exception fires, process state is no longer trustworthy —
// continuing risks serving corrupted/inconsistent results on later requests.
// Run this with a process manager (nodemon for dev, pm2/systemd/Docker
// restart policy for prod) so it comes back up automatically after exiting.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception — shutting down:', err.stack);
  process.exit(1);
});

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
});