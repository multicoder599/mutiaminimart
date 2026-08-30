const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    barcode: { type: String, unique: true, sparse: true },
    type: { type: String, default: 'others' },
    price: { type: Number, default: 0 },
    buying_price: { type: Number, default: 0 },
    stock: { type: Number, default: 0 },
    image: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);