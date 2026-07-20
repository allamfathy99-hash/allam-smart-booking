export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY غير مضاف في إعدادات Vercel.' });
  }

  try {
    const { files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'لم يتم إرسال أي ملفات للقراءة.' });
    }

    const content = [
      {
        type: 'input_text',
        text: `أنت نظام استخراج بيانات لحجوزات الشحن البحري. اقرأ المستندات المرفقة بدقة عالية وأعد JSON فقط بدون markdown أو شرح إضافي.

القواعد:
1) المستندات المصنفة "بيان الإمارات أو الفاتورة": استخرج الشاحن/المصدر، المستلم، وصف البضاعة، والوزن.
2) المستندات المصنفة "استمارة السيارة": استخرج رقم الهيكل VIN ورقم اللوحة.
3) المستند المصنف "جواز السائق": استخرج رقم الجواز واسم السائق.
4) لا تستخرج رقم البيان الجمركي السعودي من هذه الملفات؛ سيُدخل يدويًا.
5) لا تخمّن. اترك القيمة سلسلة فارغة إذا لم تكن مؤكدة.
6) رقم الهيكل غالبًا 17 خانة؛ دققه جيدًا وميّز بين O/0 وI/1.
7) أعد confidence_notes كمصفوفة نصوص قصيرة لأي خانة غير مؤكدة أو تعارض بين الملفات.

أعد هذا الشكل حرفيًا:
{
  "shipper":"",
  "consignee":"",
  "goods_description":"",
  "weight":"",
  "chassis_number":"",
  "plate_number":"",
  "passport_number":"",
  "driver_name":"",
  "confidence_notes":[]
}`
      }
    ];

    for (const file of files) {
      if (!file || !file.dataUrl) continue;
      content.push({
        type: 'input_text',
        text: `نوع المستند: ${file.category || 'غير محدد'}\nاسم الملف: ${file.name || 'بدون اسم'}`
      });

      const type = String(file.type || '');
      if (type.startsWith('image/')) {
        content.push({
          type: 'input_image',
          image_url: file.dataUrl,
          detail: 'high'
        });
      } else {
        // The Responses API accepts a complete data URL for inline file_data.
        // Keep the MIME type prefix instead of stripping it to raw base64.
        content.push({
          type: 'input_file',
          file_data: file.dataUrl,
          filename: file.name || 'document.pdf'
        });
      }
    }

    const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [
          {
            role: 'user',
            content
          }
        ],
        temperature: 0
      })
    });

    const payload = await openaiResponse.json();
    if (!openaiResponse.ok) {
      const message = payload?.error?.message || 'فشل الاتصال بخدمة الذكاء الاصطناعي.';
      return res.status(openaiResponse.status).json({ error: message });
    }

    let outputText = payload.output_text || '';
    if (!outputText && Array.isArray(payload.output)) {
      for (const item of payload.output) {
        if (!Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part.type === 'output_text' && part.text) outputText += part.text;
        }
      }
    }

    outputText = String(outputText).trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    let data;
    try {
      data = JSON.parse(outputText);
    } catch {
      return res.status(502).json({ error: 'تمت قراءة الملفات لكن تعذر تحويل النتيجة إلى بيانات منظمة. جرّب صورًا أوضح.' });
    }

    const clean = {
      shipper: data.shipper || '',
      consignee: data.consignee || '',
      goods_description: data.goods_description || '',
      weight: data.weight || '',
      chassis_number: data.chassis_number || '',
      plate_number: data.plate_number || '',
      passport_number: data.passport_number || '',
      driver_name: data.driver_name || '',
      confidence_notes: Array.isArray(data.confidence_notes) ? data.confidence_notes : []
    };

    return res.status(200).json({ data: clean });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error?.message || 'حدث خطأ غير متوقع أثناء قراءة الملفات.' });
  }
}
