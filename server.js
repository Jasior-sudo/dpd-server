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

// Endpoint testowy
app.get('/', (req, res) => {
  res.send('🚀 DPD Server działa!');
});

// ======================
// GENERUJ PACZKĘ DPD
// ======================
app.post('/api/dpd/generate-package', async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) return res.status(400).json({ error: 'Brak orderId!' });

  try {
    const { data: address, error } = await supabase
      .from('order_addresses')
      .select('*')
      .eq('order_id', orderId)
      .eq('type', 'delivery')
      .single();

    if (error || !address) {
      console.error('❌ Brak adresu dostawy:', error);
      return res.status(404).json({ error: 'Brak adresu dostawy!' });
    }

    const postalCode = (address.postcode || '').replace(/[^0-9]/g, '');
    const phone = (address.phone || '').replace(/[^0-9]/g, '');
    const phoneFormatted = phone.startsWith('48') ? phone : `48${phone}`;

   const now = Date.now();

const payload = {
  generationPolicy: 'STOP_ON_FIRST_ERROR',
  packages: [{
    reference: `PKG-${orderId}-${now}`,
    receiver: {
      company: address.company || `${address.firstname} ${address.lastname}`,
      name: `${address.firstname} ${address.lastname}`,
      address: address.street1,
      city: address.city,
      countryCode: address.country_code || 'PL',
      postalCode,
      phone: phoneFormatted,
      email: 'zamowienia@smilk.pl'
    },
    sender: {
      company: 'PRZEDSIĘBIORSTWO PRODUKCYJNO-HANDLOWO-USŁUGOWE PROSZKI MLECZNE',
      name: 'Nicolas Łusiak',
      address: 'Wyrzyska 48',
      city: 'Sadki',
      countryCode: 'PL',
      postalCode: '89110',
      phone: '48661103013',
      email: 'zamowienia@smilk.pl'
    },
    payerFID: parseInt(dpdFid),
    parcels: [{
      reference: `PARCEL-${orderId}-${now}`,
      weight: 10
    }]
  }]
};


    console.log('➡️ Payload wysyłany do DPD:', JSON.stringify(payload, null, 2));

    const dpdRes = await axios.post(dpdPackagesUrl, payload, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json',
        'x-dpd-fid': dpdFid
      }
    });

    console.log('✅ Odpowiedź z DPD:', dpdRes.data);

    const dpdData = dpdRes.data;

    if (!dpdData.sessionId || !dpdData.packages[0]?.parcels[0]?.waybill) {
      return res.status(400).json({ error: 'Brak sessionId lub waybill!' });
    }

    res.json({
      sessionId: dpdData.sessionId,
      waybill: dpdData.packages[0].parcels[0].waybill,
      rawResponse: dpdData
    });

  } catch (err) {
    console.error('❌ Błąd DPD:', err?.response?.data || err.message);
    res.status(500).json({
      error: 'Błąd DPD',
      details: err?.response?.data || err.message
    });
  }
});

// ======================
// POBIERZ ETYKIETĘ DPD
// ======================
app.post('/api/dpd/download-label', async (req, res) => {
  const { orderId, sessionId, waybill } = req.body;

  if (!orderId || !sessionId || !waybill) {
    return res.status(400).json({ error: 'Brak wymaganych danych!' });
  }

  const payload = {
    labelSearchParams: {
      policy: 'STOP_ON_FIRST_ERROR',
      session: {
        sessionId,
        packages: [{
          reference: `PKG-${orderId}`,
          parcels: [{
            reference: `PARCEL-${orderId}`,
            waybill
          }]
        }],
        type: 'DOMESTIC'
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
    console.error('❌ Błąd pobierania etykiety:', err.response?.data || err.message);
    res.status(500).json({ error: 'Błąd pobierania etykiety', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Serwer DPD działa na http://localhost:${PORT}`);
});
