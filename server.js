const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 🔧 Supabase
const supabaseUrl = 'https://nymqqcobbzmnngkgxczc.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55bXFxY29iYnptbm5na2d4Y3pjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MDkyODY4MywiZXhwIjoyMDU2NTA0NjgzfQ.zrh4GnP8BnbMZ_oa2dzhoP1Y_8RJSxd-oktLP00wREI';
const supabase = createClient(supabaseUrl, supabaseKey);

// 🔧 Dane DPD
const dpdLogin = '40413101';
const dpdPassword = 'iZRzZpcHbPswhwdg';
const dpdFid = '404131';

const dpdPackagesUrl = 'https://dpdservices.dpd.com.pl/public/shipment/v1/generatePackagesNumbers';
const dpdLabelsUrl = 'https://dpdservices.dpd.com.pl/public/shipment/v1/generateSpedLabels';

const authString = Buffer.from(`${dpdLogin}:${dpdPassword}`).toString('base64');

// Test endpoint
app.get('/', (req, res) => {
  res.send('🚀 DPD Server działa!');
});

// ==========================
// GENERUJ PACZKĘ DPD
// ==========================
app.post('/api/dpd/generate-package', async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ error: 'Brak orderId!' });
  }

  try {
    // 1️⃣ Pobieramy adres dostawy
    const { data: address, error: addressError } = await supabase
      .from('order_addresses')
      .select('*')
      .eq('order_id', orderId)
      .eq('type', 'delivery')
      .single();

    if (addressError || !address) {
      console.error('❌ Brak adresu dostawy:', addressError);
      return res.status(404).json({ error: 'Brak adresu dostawy!' });
    }

    // 2️⃣ Pobieramy dane zamówienia
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle();

    if (orderError || !order) {
      console.error('❌ Brak zamówienia:', orderError);
      return res.status(404).json({ error: 'Brak zamówienia!' });
    }

    // Debug!
    console.log('🔎 payment_method:', order.payment_method);
    console.log('🔎 shipping_method:', order.shipping_method);

    const isCOD =
      order.payment_method?.toLowerCase().includes('pobranie') ||
      order.shipping_method?.toLowerCase().includes('pobranie');

    const now = Date.now();
    const pkgRef = `PKG-${orderId}-${now}`;
    const parcelRef = `PARCEL-${orderId}-${now}`;

    const postalCode = (address.postcode || '').replace(/[^0-9]/g, '');
    const phoneRaw = (address.phone || '').replace(/[^0-9]/g, '');
    const phone = phoneRaw.startsWith('48') ? phoneRaw : `48${phoneRaw}`;

    // Payload bazowy
    const payload = {
      generationPolicy: 'STOP_ON_FIRST_ERROR',
      packages: [
        {
          reference: pkgRef,
          receiver: {
            company: address.company || `${address.firstname} ${address.lastname}`,
            name: `${address.firstname} ${address.lastname}`,
            address: address.street1,
            city: address.city,
            countryCode: address.country_code || 'PL',
            postalCode,
            phone,
            email: order.email || 'zamowienia@smilk.pl',
          },
          sender: {
            company: 'PRZEDSIĘBIORSTWO PRODUKCYJNO-HANDLOWO-USŁUGOWE PROSZKI MLECZNE',
            name: 'Nicolas Łusiak',
            address: 'Wyrzyska 48',
            city: 'Sadki',
            countryCode: 'PL',
            postalCode: '89110',
            phone: '48661103013',
            email: 'zamowienia@smilk.pl',
          },
          payerFID: parseInt(dpdFid),
          parcels: [
            {
              reference: parcelRef,
              weight: 10,
            },
          ],
        },
      ],
    };

    // ✅ DODAJEMY COD, jeśli jest wymagane
    if (isCOD) {
      payload.packages[0].cod = {
        amount: parseFloat(order.sum),
        currency: order.currency_name || 'PLN',
        beneficiary: 'PRZEDSIĘBIORSTWO PRODUKCYJNO-HANDLOWO-USŁUGOWE PROSZKI MLECZNE',
        accountNumber: 'PL08116022020000000628769404',
      };
      console.log('✅ Dodano COD do paczki:', payload.packages[0].cod);
    }

    console.log('➡️ Payload wysyłany do DPD:', JSON.stringify(payload, null, 2));

    const dpdRes = await axios.post(dpdPackagesUrl, payload, {
      headers: {
        Authorization: `Basic ${authString}`,
        'Content-Type': 'application/json',
        'x-dpd-fid': dpdFid,
      },
    });

    const dpdData = dpdRes.data;

    if (!dpdData.sessionId || !dpdData.packages?.[0]?.parcels?.[0]?.waybill) {
      return res.status(400).json({ error: 'Brak sessionId lub waybill!' });
    }

    res.json({
      sessionId: dpdData.sessionId,
      waybill: dpdData.packages[0].parcels[0].waybill,
      pkgRef,
      parcelRef,
      isCOD,
      rawResponse: dpdData,
    });
  } catch (err) {
    console.error('❌ Błąd DPD:', err?.response?.data || err.message);
    res.status(500).json({
      error: 'Błąd DPD',
      details: err?.response?.data || err.message,
    });
  }
});


// ==========================
// POBIERZ ETYKIETĘ DPD
// ==========================
app.post('/api/dpd/download-label', async (req, res) => {
  const { orderId, sessionId, waybill, pkgRef, parcelRef, isCod } = req.body;

  if (!orderId || !sessionId || !waybill || !pkgRef || !parcelRef) {
    return res.status(400).json({ error: 'Brak wymaganych danych!' });
  }

  const sessionType = isCod ? 'COD_DOMESTIC' : 'DOMESTIC';

  const payload = {
    labelSearchParams: {
      policy: 'STOP_ON_FIRST_ERROR',
      session: {
        sessionId,
        packages: [{
          reference: pkgRef,
          parcels: [{
            reference: parcelRef,
            waybill
          }]
        }],
        type: sessionType
      },
      documentId: `LABEL-${orderId}`
    },
    outputDocFormat: 'PDF',
    format: 'LBL_PRINTER',
    outputType: 'BIC3',
    variant: 'STANDARD'
  };

  console.log('➡️ Payload pobierania etykiety:', JSON.stringify(payload, null, 2));

  try {
    const dpdRes = await axios.post(dpdLabelsUrl, payload, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json',
        'x-dpd-fid': dpdFid
      }
    });

    const labelData = dpdRes.data.documentData;

    if (!labelData) {
      console.error('❌ Brak danych etykiety!');
      return res.status(400).json({ error: 'Brak danych etykiety!' });
    }

    const buffer = Buffer.from(labelData, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(buffer);

  } catch (err) {
    console.error('❌ Błąd pobierania etykiety:', err?.response?.data || err.message);
    res.status(500).json({
      error: 'Błąd pobierania etykiety',
      details: err?.response?.data || err.message
    });
  }
});

// ==========================
// START SERVERA
// ==========================
app.listen(PORT, () => {
  console.log(`🚀 Serwer DPD działa na http://localhost:${PORT}`);
});
