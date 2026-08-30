require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// --- DATABASE MODELS ---
const connectDB = require('./config/db');
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
const MpesaTransaction = require('./models/MpesaTransaction');
const WebhookLog = require('./models/WebhookLog');

// --- ANTI-CHEAT AUDIT LOG SCHEMA ---
const StockLogSchema = new mongoose.Schema({
    item_name: String,
    qty_added: Number,
    cashier_name: String,
    createdAt: { type: Date, default: Date.now }
});
const StockLog = mongoose.model('StockLog', StockLogSchema);

// EXPENDITURE SCHEMA
const ExpenditureSchema = new mongoose.Schema({
    description: String,
    amount: Number,
    added_by: String,
    date: { type: Date, default: Date.now }
});
const Expenditure = mongoose.model('Expenditure', ExpenditureSchema);

// 1. Connect to Database
connectDB();

// ==========================================
// 2. CENTRAL API & CASHIER SERVER (PORT 4004)
// ==========================================
const API_PORT = 4004;
const STORE_ID = 'STALLION';
const MEGAPAY_API_KEY = process.env.MEGAPAY_API_KEY;
const MEGAPAY_EMAIL = process.env.MEGAPAY_EMAIL;

const apiApp = express();
apiApp.use(cors());
apiApp.use(express.json());
apiApp.use(express.urlencoded({ extended: true }));

// In-memory MegaPay tracking
const pendingTransactions = new Map();
let connectedClients = [];

// ==========================================
// --- API ROUTES ---
// ==========================================

// ------------------------------------------
// AUTHENTICATION
// ------------------------------------------
apiApp.post('/api/login', async (req, res) => {
    const { username, pin, attemptedRole } = req.body;
    try {
        const user = await User.findOne({ username, pin_hash: pin });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
        if (user.isActive === false && user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Account suspended. Contact Admin.' });
        }
        if (user.role === attemptedRole || user.role === 'admin') {
            res.json({ success: true, token: 'temp-auth-token', role: user.role });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials or wrong portal' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ------------------------------------------
// USER MANAGEMENT (Admin & Cashier only)
// ------------------------------------------
apiApp.get('/api/staff', async (req, res) => {
    try {
        const staff = await User.find({ role: { $in: ['admin', 'cashier'] } }, '-pin_hash').sort({ createdAt: -1 });
        res.json({ success: true, staff });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

apiApp.post('/api/staff', async (req, res) => {
    try {
        const { username, role, pin } = req.body;
        if (!['admin','cashier'].includes(role)) return res.status(400).json({ success: false, message: 'Invalid role' });
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ success: false, message: 'Username already exists' });
        const newUser = await User.create({ username, role, pin_hash: pin });
        res.json({ success: true, message: 'User added successfully!', user: newUser });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to add user' });
    }
});

apiApp.patch('/api/staff/:id/edit', async (req, res) => {
    try {
        const { username, isActive } = req.body;
        const updateData = {};
        if (username !== undefined) updateData.username = username;
        if (isActive !== undefined) updateData.isActive = isActive;
        const updatedUser = await User.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.json({ success: true, user: updatedUser });
    } catch (error) {
        res.status(500).json({ success: false, message: `Failed to update: ${error.message}` });
    }
});

apiApp.patch('/api/staff/:id/password', async (req, res) => {
    try {
        const { newPin } = req.body;
        await User.findByIdAndUpdate(req.params.id, { pin_hash: newPin });
        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update password' });
    }
});

apiApp.delete('/api/staff/:id', async (req, res) => {
    try {
        const userToDelete = await User.findById(req.params.id);
        if (userToDelete && userToDelete.username === 'admin') {
            return res.status(400).json({ success: false, message: 'Cannot delete the main admin account!' });
        }
        await User.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'User deleted successfully!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete user' });
    }
});

// ------------------------------------------
// EXPENDITURES
// ------------------------------------------
apiApp.get('/api/expenditures', async (req, res) => {
    try {
        const expenses = await Expenditure.find({}).sort({ date: -1 });
        res.json({ success: true, expenses });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiApp.post('/api/expenditures', async (req, res) => {
    try {
        const { description, amount, added_by } = req.body;
        const newExpense = await Expenditure.create({ description, amount: Number(amount), added_by: added_by || 'Admin' });
        res.json({ success: true, expense: newExpense });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ------------------------------------------
// PRODUCTS, INVENTORY & AUDIT LOGS
// ------------------------------------------
apiApp.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find({});
        res.json({ success: true, products });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch products' });
    }
});

// Lookup product by barcode
apiApp.get('/api/products/barcode/:code', async (req, res) => {
    try {
        const product = await Product.findOne({ barcode: req.params.code });
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiApp.post('/api/products', async (req, res) => {
    try {
        const { name, type, price, buying_price, stock, barcode, image } = req.body;
        const newProduct = await Product.create({
            name,
            barcode: barcode || null,
            type: (type || 'others').toLowerCase(),
            price: Number(price) || 0,
            buying_price: Number(buying_price) || 0,
            stock: Number(stock) || 0,
            image: image || null
        });
        res.json({ success: true, message: 'Product created!', product: newProduct });
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ success: false, message: `DB Error: ${error.message}` });
    }
});

apiApp.patch('/api/products/:id', async (req, res) => {
    try {
        const { price, buying_price, addedStock, cashierName, barcode, image, name } = req.body;
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
        if (price !== undefined && price !== '') product.price = Number(price);
        if (buying_price !== undefined && buying_price !== '') product.buying_price = Number(buying_price);
        if (barcode !== undefined) product.barcode = barcode;
        if (image !== undefined) product.image = image;
        if (name !== undefined) product.name = name;
        if (addedStock && Number(addedStock) > 0) {
            product.stock = (product.stock || 0) + Number(addedStock);
            await StockLog.create({ item_name: product.name, qty_added: Number(addedStock), cashier_name: cashierName || "Unknown" });
        }
        await product.save();
        res.json({ success: true, message: 'Inventory updated', product });
    } catch (error) {
        res.status(500).json({ success: false, message: `Failed to update inventory: ${error.message}` });
    }
});

apiApp.delete('/api/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Product deleted!' });
    } catch (error) {
        res.status(500).json({ success: false, message: `DB Error: ${error.message}` });
    }
});

apiApp.get('/api/stock-logs', async (req, res) => {
    try {
        const logs = await StockLog.find().sort({ createdAt: -1 }).limit(50);
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiApp.delete('/api/stock-logs/:id', async (req, res) => {
    try {
        await StockLog.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Stock alert deleted!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiApp.get('/api/products/wipe-test-data', async (req, res) => {
    try {
        await Product.deleteMany({});
        res.json({ success: true, message: 'All products wiped permanently!' });
    } catch (error) {
        res.status(500).json({ success: false, message: `DB Error: ${error.message}` });
    }
});

// ------------------------------------------
// ORDERS
// ------------------------------------------
apiApp.get('/api/orders', async (req, res) => {
    try {
        const orders = await Order.find({}).sort({ createdAt: -1 });
        res.json({ success: true, orders });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch orders' });
    }
});

apiApp.post('/api/orders', async (req, res) => {
    try {
        const { items, total_amount, served_by, customer_name, payment_method, mpesa_receipt, cash_tendered, cash_change } = req.body;
        const adminUser = await User.findOne({ username: 'admin' });
        const newOrder = await Order.create({
            user_id: adminUser ? adminUser._id : null,
            table_number: 'Walk-in',
            items: items,
            total_amount: total_amount,
            status: 'completed',
            served_by: served_by || 'Cashier',
            customer_name: customer_name || 'WALK-IN',
            payment_method: payment_method || 'cash',
            mpesa_receipt: mpesa_receipt || null,
            cash_tendered: cash_tendered || null,
            cash_change: cash_change || null
        });
        if (items && items.length > 0) {
            for (let item of items) {
                if (item.product_id) {
                    await Product.findByIdAndUpdate(item.product_id, { $inc: { stock: -item.quantity } });
                }
            }
        }
        res.json({ success: true, order: newOrder });
    } catch (error) {
        res.status(500).json({ success: false, message: `Failed to save order: ${error.message}` });
    }
});

// ------------------------------------------
// DAILY SALES ENDPOINT
// ------------------------------------------
apiApp.get('/api/sales/today', async (req, res) => {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    try {
        const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: 'completed' });
        const totalSales = orders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
        const cashSales = orders.filter(o => o.payment_method === 'cash').reduce((sum, o) => sum + (o.total_amount || 0), 0);
        const mpesaSales = orders.filter(o => o.payment_method === 'mpesa').reduce((sum, o) => sum + (o.total_amount || 0), 0);
        const orderCount = orders.length;
        res.json({ success: true, totalSales, cashSales, mpesaSales, orderCount, orders });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ------------------------------------------
// MEGAPAY STK INTEGRATION
// ------------------------------------------
apiApp.post('/api/initiate-payment', async (req, res) => {
    const { amount, phoneNumber } = req.body;
    if (!amount || !phoneNumber) return res.status(400).json({ success: false, message: "Amount and Phone Number are required." });

    if (!MEGAPAY_API_KEY || !MEGAPAY_EMAIL) {
        return res.status(500).json({ success: false, message: "Payment gateway not configured." });
    }

    let formattedPhone = phoneNumber.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    else if (formattedPhone.startsWith('+')) formattedPhone = formattedPhone.substring(1);

    const reference = `STALLION-${Date.now()}`;
    const payload = {
        api_key: MEGAPAY_API_KEY,
        email: MEGAPAY_EMAIL,
        amount: amount,
        msisdn: formattedPhone,
        callback_url: `http://169.58.58.133:${API_PORT}/api/megapay/webhook`,
        description: `Stallion Minimart Checkout`,
        reference: reference
    };

    pendingTransactions.set(reference, {
        status: 'Pending',
        amount: parseFloat(amount),
        phone: formattedPhone,
        startTime: Date.now()
    });

    try {
        const mpRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 35000
        });
        const mpData = mpRes.data;
        if (mpData && (mpData.status === false || mpData.success === false || mpData.ResponseCode === '1')) {
            pendingTransactions.delete(reference);
            return res.status(400).json({ success: false, message: mpData.errorMessage || mpData.message || 'MegaPay rejected the request.' });
        }
        return res.status(200).json({ success: true, message: 'STK Push sent! Waiting for customer PIN.', refId: reference });
    } catch (mpErr) {
        console.error('MegaPay STK Error:', mpErr.message);
        return res.status(502).json({ success: false, message: 'Payment gateway timed out.', refId: reference });
    }
});

apiApp.get('/api/stream-payment/:refId', (req, res) => {
    const { refId } = req.params;
    const tx = pendingTransactions.get(refId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (tx && tx.status === 'Paid') {
        res.write(`data: ${JSON.stringify({ success: true, receipt: tx.receipt })}\n\n`);
        res.end();
        return;
    }
    if (tx && tx.status === 'Failed') {
        res.write(`data: ${JSON.stringify({ success: false, message: tx.failureReason })}\n\n`);
        res.end();
        return;
    }

    const client = { refId, res };
    connectedClients.push(client);
    req.on('close', () => { connectedClients = connectedClients.filter(c => c !== client); });
});

apiApp.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const ip = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
    console.log(`[${STORE_ID}] WEBHOOK HIT from ${ip}`);

    if (!req.body || Object.keys(req.body).length === 0) {
        console.error(`[${STORE_ID}] EMPTY BODY received.`);
        return;
    }

    let data = req.body;
    if (typeof req.body === 'string') {
        try { data = JSON.parse(req.body); } catch (e) { data = req.body; }
    }
    const rawPayload = JSON.stringify(data);

    try {
        const responseCode = data.ResponseCode !== undefined ? String(data.ResponseCode) : (data.ResultCode !== undefined ? String(data.ResultCode) : undefined);
        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount || 0);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.receipt || 'N/A';
        const phoneRaw = (data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || "").toString();
        const last9 = phoneRaw.replace(/\D/g, '').slice(-9);
        const callbackRef = data.reference || data.Reference || data.TransactionReference || data.BillRefNumber || null;

        let matchedRefId = null;
        let matchedTx = null;

        if (callbackRef && pendingTransactions.has(callbackRef)) {
            const tx = pendingTransactions.get(callbackRef);
            if (tx.status === 'Pending') { matchedRefId = callbackRef; matchedTx = tx; }
        }

        if (!matchedRefId) {
            const now = Date.now();
            for (let [refId, tx] of pendingTransactions.entries()) {
                if (tx.status !== 'Pending') continue;
                if (now - tx.startTime > 10 * 60 * 1000) continue;
                if (tx.phone.endsWith(last9) && Math.abs(tx.amount - amount) < 0.01) {
                    matchedRefId = refId; matchedTx = tx; break;
                }
            }
        }

        await WebhookLog.create({ store_id: STORE_ID, ref_id: callbackRef || matchedRefId || 'UNKNOWN', raw_payload: rawPayload, matched_ref: matchedRefId || null });

        if (responseCode !== '0') {
            if (matchedRefId) {
                matchedTx.status = 'Failed';
                matchedTx.failureReason = data.ResultDesc || data.errorMessage || 'Customer cancelled or did not enter PIN';
                connectedClients.forEach(c => { if (c.refId === matchedRefId) c.res.write(`data: ${JSON.stringify({ success: false, message: matchedTx.failureReason })}\n\n`); });
            }
            return;
        }

        if (matchedRefId) {
            matchedTx.status = 'Paid';
            matchedTx.receipt = receipt;
            await MpesaTransaction.create({ store_id: STORE_ID, ref_id: matchedRefId, receipt, phone: matchedTx.phone, amount: matchedTx.amount, status: 'Paid' });
            connectedClients.forEach(c => { if (c.refId === matchedRefId) c.res.write(`data: ${JSON.stringify({ success: true, receipt })}\n\n`); });
        } else {
            console.log(`[${STORE_ID}] No pending match for receipt ${receipt}.`);
        }
    } catch (err) {
        console.error(`[${STORE_ID}] Webhook processing error:`, err.message);
    }
});

apiApp.get('/api/transactions/today', async (req, res) => {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    try {
        const transactions = await MpesaTransaction.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 });
        const total = transactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);
        res.json({ success: true, total, count: transactions.length, transactions });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

apiApp.get('/api/transactions/all', async (req, res) => {
    try {
        const transactions = await MpesaTransaction.find({}).sort({ createdAt: -1 }).limit(200);
        res.json({ success: true, transactions });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Cleanup expired transactions every 2 minutes
setInterval(() => {
    const now = Date.now();
    for (let [refId, tx] of pendingTransactions.entries()) {
        if (tx.status !== 'Pending') continue;
        if (now - tx.startTime > 5 * 60 * 1000) {
            tx.status = 'Expired';
            tx.failureReason = 'Transaction expired (no response from customer)';
            connectedClients.forEach(c => { if (c.refId === refId) c.res.write(`data: ${JSON.stringify({ success: false, message: tx.failureReason })}\n\n`); });
            setTimeout(() => { if (pendingTransactions.get(refId)?.status === 'Expired') pendingTransactions.delete(refId); }, 10 * 60 * 1000);
        }
    }
}, 120000);

// ------------------------------------------
// SERVE CASHIER FRONTEND
// ------------------------------------------
apiApp.use(express.static(path.join(__dirname, 'public/cashier')));

apiApp.listen(API_PORT, '0.0.0.0', () => {
    console.log(`Stallion Minimart API & Cashier running on http://169.58.58.133:${API_PORT}`);
});

// ==========================================
// 3. ADMIN FRONTEND SERVER (PORT 4005)
// ==========================================
const adminApp = express();
adminApp.use(cors());
adminApp.use(express.static(path.join(__dirname, 'public/admin')));
adminApp.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});
adminApp.listen(4005, '0.0.0.0', () => {
    console.log(`Stallion Minimart Admin Portal running on http://169.58.58.133:4005`);
});