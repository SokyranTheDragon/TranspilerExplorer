using Newtonsoft.Json.Linq;
using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;

namespace TranspilerExplorer
{
    public static class Extensions
    {
        public static void WriteBytes(this HttpListenerResponse resp, byte[] data)
        {
            resp.ContentLength64 = data.LongLength;
            resp.OutputStream.Write(data, 0, data.Length);
        }

        public static void WriteJson(this HttpListenerResponse resp, JToken obj)
        {
            resp.ContentType = "application/json; charset=utf-8";
            resp.ContentEncoding = Encoding.UTF8;
            resp.WriteBytes(Encoding.UTF8.GetBytes(obj.ToString(Newtonsoft.Json.Formatting.None)));
        }

        // POST bodies are JSON objects. An empty body reads as {}.
        public static JObject ReadJson(this HttpListenerRequest req)
        {
            if (!req.HasEntityBody)
                return new JObject();

            using var reader = new StreamReader(req.InputStream, req.ContentEncoding ?? Encoding.UTF8);
            var text = reader.ReadToEnd();
            return string.IsNullOrWhiteSpace(text) ? new JObject() : JObject.Parse(text);
        }

        public static string PathPart(this Uri url, int index)
        {
            return url.AbsolutePath.Split(['/'], StringSplitOptions.RemoveEmptyEntries).ElementAtOrDefault(index);
        }
    }
}
