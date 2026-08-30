const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const orderItemSchema = new mongoose.Schema({
    product_id: { type: String, ref: 'Product', required: true },
    name: { type: String },
    quantity: { type: Number, default: 1 },
    unit_price: { type: Number, required: true }
}, { _id: false });

const orderSchema = new mongoose.Schema({
    _id: { type: String, default: uuidv4 },
    user_id: { type: String, ref: 'User' },
    table_number: { type: String },
    items: [orderItemSchema],
    total_amount: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'completed', 'voided'], default: 'completed' },
    customer_name: { type: String, default: 'WALK-IN' },
    served_by: { type: String, default: 'Cashier' },
    payment_method: { type: String, default: 'cash' },
    mpesa_receipt: { type: String, default: null }
}, { timestamps: true });

orderSchema.index({ createdAt: -1 });
module.exports = mongoose.model('Order', orderSchema);