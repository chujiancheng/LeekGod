/**
 * 限价订单簿：价格优先、时间优先
 */
class OrderBook {
  constructor() {
    this.bids = []; // 买盘，价格从高到低；同价按时间
    this.asks = []; // 卖盘，价格从低到高；同价按时间
    this.orders = new Map(); // id -> order
    this.seq = 0;
  }

  /** 生成订单号 */
  nextId() {
    this.seq += 1;
    return 'O' + this.seq;
  }

  /**
   * 挂单入簿（必须是未成交或部分成交的限价单）
   */
  add(order) {
    if (!order.id) order.id = this.nextId();
    order.bookId = order.id;
    const book = order.side === 'buy' ? this.bids : this.asks;
    if (order.side === 'buy') {
      // 价格降序，同价早单在前
      let i = book.length;
      while (i > 0 && book[i - 1].price < order.price) i--;
      while (i > 0 && book[i - 1].price === order.price && book[i - 1].seq > order.seq) i--;
      book.splice(i, 0, order);
    } else {
      // 价格升序，同价早单在前
      let i = book.length;
      while (i > 0 && book[i - 1].price > order.price) i--;
      while (i > 0 && book[i - 1].price === order.price && book[i - 1].seq > order.seq) i--;
      book.splice(i, 0, order);
    }
    this.orders.set(order.id, order);
    return order;
  }

  /** 撤单，返回订单或 null */
  cancel(id) {
    const order = this.orders.get(id);
    if (!order) return null;
    this.remove(order);
    return order;
  }

  remove(order) {
    const book = order.side === 'buy' ? this.bids : this.asks;
    const idx = book.indexOf(order);
    if (idx >= 0) book.splice(idx, 1);
    this.orders.delete(order.id);
  }

  /** 对手方最优价（买方视角：一档卖价 ask，一档买价 bid） */
  bestBid() {
    return this.bids.length ? this.bids[0].price : null;
  }

  bestAsk() {
    return this.asks.length ? this.asks[0].price : null;
  }

  /** 订单剩余量 */
  remain(order) {
    return order.qty - (order.filled || 0);
  }

  /** 五档深度（按剩余量） */
  depth(levels) {
    const bids = [];
    const asks = [];
    for (let i = 0; i < levels; i++) {
      if (i < this.bids.length) {
        bids.push({ price: this.bids[i].price, qty: this.remain(this.bids[i]) });
      }
      if (i < this.asks.length) {
        asks.push({ price: this.asks[i].price, qty: this.remain(this.asks[i]) });
      }
    }
    return { bids, asks };
  }

  /**
   * 汇总盘口数量（同一价位多单合并，按剩余量）
   */
  depthAgg(levels) {
    const agg = (book) => {
      const map = new Map();
      for (const o of book) {
        map.set(o.price, (map.get(o.price) || 0) + this.remain(o));
      }
      const out = [];
      for (const [price, qty] of map) {
        out.push({ price, qty });
        if (out.length >= levels) break;
      }
      return out;
    };
    return { bids: agg(this.bids), asks: agg(this.asks) };
  }
}

module.exports = { OrderBook };
